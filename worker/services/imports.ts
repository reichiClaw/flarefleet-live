import type { ImportJob, ImportRow, Language } from "@shared/types";
import type { Env, SessionUser } from "../env";
import { all, json, now, one, reserveSequence, stmt, uid } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { auditStatement } from "../lib/audit";
import { formatInternalNumber } from "@shared/domain";
import { excelSerialToDate, readCsv, readXlsx, writeXlsx, type CellValue } from "../lib/xlsx";
import { newQrCode } from "./vehicles";

export const IMPORT_COLUMNS = [
  "internal_number",
  "external_key",
  "category",
  "manufacturer",
  "model",
  "serial_number",
  "license_plate",
  "supplier",
  "expected_arrival",
  "odometer_km",
  "operating_hours",
  "location",
  "notes",
] as const;
type Column = (typeof IMPORT_COLUMNS)[number];
const REQUIRED: Column[] = ["manufacturer", "model", "category"];

const ALIASES: Record<Column, string[]> = {
  internal_number: ["internal_number", "interne nummer", "internenummer", "nummer", "inventarnummer", "fz-nr", "id", "number"],
  external_key: ["external_key", "externer schlüssel", "externe id", "ext_id", "key", "referenz", "reference"],
  category: ["category", "kategorie", "typ", "type", "fahrzeugtyp", "gerätetyp"],
  manufacturer: ["manufacturer", "hersteller", "marke", "brand", "make"],
  model: ["model", "modell", "bezeichnung"],
  serial_number: ["serial_number", "seriennummer", "serien-nr", "serial", "sn", "fin", "vin", "fahrgestellnummer"],
  license_plate: ["license_plate", "kennzeichen", "kfz-kennzeichen", "plate", "nummernschild"],
  supplier: ["supplier", "lieferant", "hersteller-firma", "vendor"],
  expected_arrival: ["expected_arrival", "erwartete ankunft", "ankunft", "liefertermin", "lieferdatum", "arrival", "eta", "delivery"],
  odometer_km: ["odometer_km", "kilometerstand", "km", "kilometer", "odometer", "mileage"],
  operating_hours: ["operating_hours", "betriebsstunden", "stunden", "hours", "bh"],
  location: ["location", "standort", "lagerort", "ort", "site"],
  notes: ["notes", "bemerkung", "bemerkungen", "notizen", "kommentar", "comment", "remarks"],
};

const norm = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./]+/g, " ")
    .replace(/\s+/g, " ");

function mapHeaders(header: CellValue[]): Record<string, Column> {
  const mapping: Record<string, Column> = {};
  header.forEach((h, idx) => {
    const n = norm(h);
    if (!n) return;
    for (const col of IMPORT_COLUMNS) {
      if (mapping[String(idx)]) break;
      if (ALIASES[col].some((a) => norm(a) === n)) mapping[String(idx)] = col;
    }
  });
  return mapping;
}

function cellString(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

function cellDate(v: CellValue): string | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return v > 20000 && v < 80000 ? excelSerialToDate(v) : null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (de) {
    const y = de[3].length === 2 ? `20${de[3]}` : de[3];
    return `${y}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`;
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return "invalid";
}

/**
 * Accepts both notations found in real sheets: "1.234,5" (German) and "1,234.5"
 * or "12.5" (English). The last separator present decides which one is decimal,
 * so a plain "12.5" is no longer read as 125.
 */
function cellNumber(v: CellValue): number | null | "invalid" {
  if (v === null || v === "") return null;
  if (typeof v === "number") return v;
  const raw = String(v).trim().replace(/\s|'|\u00a0/g, "");
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  let normalized = raw;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // A single comma is a decimal separator unless it groups thousands ("1,234").
    normalized = /,\d{3}$/.test(raw) && raw.length > 4 ? raw.replace(/,/g, "") : raw.replace(",", ".");
  } else if (lastDot >= 0) {
    normalized = /\.\d{3}$/.test(raw) && raw.length > 4 ? raw.replace(/\./g, "") : raw;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : "invalid";
}

interface ParsedRow {
  row_number: number;
  data: Record<string, string | number | null>;
}

export function parseSheet(filename: string, bytes: Uint8Array): { columns: Record<string, string>; rows: ParsedRow[]; missing: string[] } {
  let matrix: CellValue[][];
  try {
    if (/\.csv$/i.test(filename)) matrix = readCsv(new TextDecoder("utf-8").decode(bytes));
    else matrix = readXlsx(bytes);
  } catch {
    throw badRequest("import_file");
  }
  const headerIdx = matrix.findIndex((r) => r.some((c) => c !== null && String(c).trim() !== ""));
  if (headerIdx < 0) throw badRequest("import_no_rows");
  const mapping = mapHeaders(matrix[headerIdx]);
  const mapped = new Set(Object.values(mapping));
  const missing = REQUIRED.filter((c) => !mapped.has(c));
  const columns: Record<string, string> = {};
  for (const [idx, col] of Object.entries(mapping)) columns[String(matrix[headerIdx][Number(idx)] ?? idx)] = col;

  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r || !r.some((c) => c !== null && String(c).trim() !== "")) continue;
    const data: Record<string, string | number | null> = {};
    for (const [idx, col] of Object.entries(mapping)) {
      const v = r[Number(idx)] ?? null;
      if (col === "expected_arrival") data[col] = cellDate(v);
      else if (col === "odometer_km" || col === "operating_hours") {
        const n = cellNumber(v);
        data[col] = n === "invalid" ? "invalid" : n;
      } else data[col] = cellString(v);
    }
    rows.push({ row_number: i + 1, data });
  }
  return { columns, rows, missing };
}

interface Lookups {
  categories: Map<string, string>;
  suppliers: Map<string, string>;
  byInternal: Map<string, { id: string; status: string }>;
  byExternal: Map<string, { id: string; status: string }>;
  bySerial: Map<string, { id: string; status: string }>;
  byPlate: Map<string, { id: string; status: string }>;
}

async function loadLookups(env: Env): Promise<Lookups> {
  const cats = await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM categories WHERE is_active = 1");
  const sups = await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM companies WHERE company_type = 'supplier' AND is_active = 1");
  const vehicles = await all<{ id: string; status: string; internal_number: string; external_key: string | null; serial_number: string; license_plate: string }>(
    env.DB,
    "SELECT id, status, internal_number, external_key, serial_number, license_plate FROM vehicles",
  );
  const l: Lookups = {
    categories: new Map(cats.map((c) => [norm(c.name), c.id])),
    suppliers: new Map(sups.map((s) => [norm(s.name), s.id])),
    byInternal: new Map(),
    byExternal: new Map(),
    bySerial: new Map(),
    byPlate: new Map(),
  };
  for (const v of vehicles) {
    l.byInternal.set(norm(v.internal_number), v);
    if (v.external_key) l.byExternal.set(norm(v.external_key), v);
    if (v.serial_number) l.bySerial.set(norm(v.serial_number), v);
    if (v.license_plate) l.byPlate.set(norm(v.license_plate), v);
  }
  return l;
}

const MESSAGES: Record<string, Record<Language, string>> = {
  required: { de: "Pflichtfeld fehlt", en: "Required value missing" },
  invalid_number: { de: "Keine gültige Zahl", en: "Not a valid number" },
  invalid_date: { de: "Kein gültiges Datum (TT.MM.JJJJ oder JJJJ-MM-TT)", en: "Not a valid date (DD.MM.YYYY or YYYY-MM-DD)" },
  duplicate_in_file: { de: "Kommt in der Datei mehrfach vor", en: "Appears more than once in the file" },
  not_announced: { de: "Fahrzeug existiert bereits und ist nicht mehr im Status 'angekündigt'", en: "Vehicle already exists and is no longer 'announced'" },
  conflict: { de: "Wert ist bereits bei einem anderen Fahrzeug vergeben", en: "Value already used by another vehicle" },
};

function validateRows(rows: ParsedRow[], lookups: Lookups, lang: Language): ImportRow[] {
  const seen: Record<string, Map<string, number>> = { internal_number: new Map(), external_key: new Map(), serial_number: new Map(), license_plate: new Map() };
  const out: ImportRow[] = rows.map((r) => {
    const errors: { field: string; message: string }[] = [];
    const d = r.data;
    for (const f of REQUIRED) if (!cellString(d[f] as CellValue)) errors.push({ field: f, message: MESSAGES.required[lang] });
    for (const f of ["odometer_km", "operating_hours"]) if (d[f] === "invalid") errors.push({ field: f, message: MESSAGES.invalid_number[lang] });
    if (d.expected_arrival === "invalid") errors.push({ field: "expected_arrival", message: MESSAGES.invalid_date[lang] });
    for (const f of Object.keys(seen)) {
      const v = norm(d[f]);
      if (!v) continue;
      const prev = seen[f].get(v);
      if (prev !== undefined) errors.push({ field: f, message: `${MESSAGES.duplicate_in_file[lang]} (Zeile/row ${prev})` });
      else seen[f].set(v, r.row_number);
    }

    // match existing vehicle
    const match =
      (d.external_key && lookups.byExternal.get(norm(d.external_key))) ||
      (d.internal_number && lookups.byInternal.get(norm(d.internal_number))) ||
      (d.serial_number && lookups.bySerial.get(norm(d.serial_number))) ||
      null;
    let action: ImportRow["action"] = match ? "update" : "create";
    if (match && match.status !== "announced") {
      errors.push({ field: "internal_number", message: MESSAGES.not_announced[lang] });
    }
    // uniqueness against other vehicles
    for (const [f, map] of [
      ["internal_number", lookups.byInternal],
      ["external_key", lookups.byExternal],
      ["serial_number", lookups.bySerial],
      ["license_plate", lookups.byPlate],
    ] as [string, Map<string, { id: string }>][]) {
      const v = norm(d[f]);
      if (!v) continue;
      const other = map.get(v);
      if (other && (!match || other.id !== match.id)) errors.push({ field: f, message: MESSAGES.conflict[lang] });
    }
    if (errors.length) action = "error";
    return { row_number: r.row_number, action, data: d, errors, matched_vehicle_id: match ? match.id : null, result_vehicle_id: null };
  });
  return out;
}

export async function createImportJob(env: Env, user: SessionUser, lang: Language, filename: string, bytes: Uint8Array, ip: string): Promise<ImportJob> {
  const { columns, rows, missing } = parseSheet(filename, bytes);
  if (missing.length) throw badRequest("import_missing_columns", undefined, { columns: missing.join(", ") });
  if (!rows.length) throw badRequest("import_no_rows");
  if (rows.length > 2000) throw badRequest("validation", { rows: "max 2000" });
  const lookups = await loadLookups(env);
  const validated = validateRows(rows, lookups, lang);
  const id = uid();
  const ts = now();
  const errorCount = validated.filter((r) => r.action === "error").length;
  const statements = [
    stmt(
      env.DB,
      "INSERT INTO import_jobs (id, filename, status, columns, row_count, valid_count, error_count, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      filename.slice(0, 200),
      errorCount === validated.length ? "failed" : "validated",
      JSON.stringify(columns),
      validated.length,
      validated.length - errorCount,
      errorCount,
      user.id,
      ts,
    ),
    ...validated.map((r) =>
      stmt(
        env.DB,
        "INSERT INTO import_rows (job_id, row_number, action, data, errors, matched_vehicle_id) VALUES (?,?,?,?,?,?)",
        id,
        r.row_number,
        r.action,
        JSON.stringify(r.data),
        JSON.stringify(r.errors),
        r.matched_vehicle_id,
      ),
    ),
    auditStatement(env.DB, {
      actor_id: user.id,
      actor_label: user.name,
      action: "import.validated",
      entity_type: "import_job",
      entity_id: id,
      details: { filename, rows: validated.length, errors: errorCount },
      ip,
    }),
  ];
  // D1 batches are limited in size; chunk the row inserts.
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  return getImportJob(env, id, true);
}

function shapeJob(j: Record<string, unknown>): ImportJob {
  return {
    id: j.id as string,
    filename: j.filename as string,
    status: j.status as ImportJob["status"],
    columns: json(j.columns, {}),
    row_count: Number(j.row_count),
    valid_count: Number(j.valid_count),
    error_count: Number(j.error_count),
    created_count: Number(j.created_count),
    updated_count: Number(j.updated_count),
    created_by: j.created_by as string,
    committed_at: (j.committed_at as string | null) ?? null,
    created_at: j.created_at as string,
  };
}

export async function getImportJob(env: Env, id: string, withRows: boolean): Promise<ImportJob> {
  const j = await one<Record<string, unknown>>(env.DB, "SELECT * FROM import_jobs WHERE id = ?", id);
  if (!j) throw notFound();
  const job = shapeJob(j);
  if (withRows) {
    const rows = await all<Record<string, unknown>>(env.DB, "SELECT * FROM import_rows WHERE job_id = ? ORDER BY row_number", id);
    job.rows = rows.map((r) => ({
      row_number: Number(r.row_number),
      action: r.action as ImportRow["action"],
      data: json(r.data, {}),
      errors: json(r.errors, []),
      matched_vehicle_id: (r.matched_vehicle_id as string | null) ?? null,
      result_vehicle_id: (r.result_vehicle_id as string | null) ?? null,
    }));
  }
  return job;
}

export async function listImportJobs(env: Env): Promise<ImportJob[]> {
  const rows = await all<Record<string, unknown>>(env.DB, "SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 50");
  return rows.map(shapeJob);
}

export async function commitImportJob(env: Env, user: SessionUser, lang: Language, id: string, onlyValid: boolean, ip: string): Promise<ImportJob> {
  const job = await getImportJob(env, id, true);
  if (job.status !== "validated") throw conflict("import_not_committable");
  // Re-validate against the current database state; things may have changed since upload.
  const lookups = await loadLookups(env);
  const revalidated = validateRows(
    job.rows!.map((r) => ({ row_number: r.row_number, data: r.data })),
    lookups,
    lang,
  );
  const errors = revalidated.filter((r) => r.action === "error");
  if (errors.length && !onlyValid) throw conflict("import_has_errors");

  const ts = now();
  const statements: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;
  const categoryIds = new Map(lookups.categories);
  const supplierIds = new Map(lookups.suppliers);

  // Reserve every internal number we may need in a single round trip instead of
  // one sequence query per row.
  const needsNumber = revalidated.filter(
    (r) => r.action === "create" && !cellString(r.data.internal_number as CellValue),
  ).length;
  const taken = new Set(lookups.byInternal.keys());
  const reserved: string[] = [];
  if (needsNumber) {
    for (const n of await reserveSequence(env.DB, "vehicle", needsNumber)) {
      const candidate = formatInternalNumber(n);
      if (!taken.has(norm(candidate))) reserved.push(candidate);
    }
    // Extremely rare: a reserved number collides with a manually assigned one.
    while (reserved.length < needsNumber) {
      const candidate = formatInternalNumber((await reserveSequence(env.DB, "vehicle", 1))[0]);
      if (!taken.has(norm(candidate))) reserved.push(candidate);
    }
  }

  for (const r of revalidated) {
    if (r.action === "error") {
      statements.push(stmt(env.DB, "UPDATE import_rows SET action = 'error', errors = ? WHERE job_id = ? AND row_number = ?", JSON.stringify(r.errors), id, r.row_number));
      continue;
    }
    const d = r.data;
    const catKey = norm(d.category);
    let categoryId = categoryIds.get(catKey);
    if (!categoryId) {
      categoryId = uid();
      categoryIds.set(catKey, categoryId);
      statements.push(stmt(env.DB, "INSERT INTO categories (id, name, meter_mode, is_active, created_at, updated_at) VALUES (?,?,'both',1,?,?)", categoryId, cellString(d.category as CellValue), ts, ts));
    }
    let supplierId: string | null = null;
    const supKey = norm(d.supplier);
    if (supKey) {
      supplierId = supplierIds.get(supKey) ?? null;
      if (!supplierId) {
        supplierId = uid();
        supplierIds.set(supKey, supplierId);
        statements.push(stmt(env.DB, "INSERT INTO companies (id, name, company_type, is_active, created_at, updated_at) VALUES (?,?,'supplier',1,?,?)", supplierId, cellString(d.supplier as CellValue), ts, ts));
      }
    }
    const odometer = typeof d.odometer_km === "number" ? Math.round(d.odometer_km) : null;
    const hours = typeof d.operating_hours === "number" ? d.operating_hours : null;
    const arrival = typeof d.expected_arrival === "string" && d.expected_arrival !== "invalid" ? d.expected_arrival : null;

    if (r.action === "update" && r.matched_vehicle_id) {
      updated++;
      statements.push(
        stmt(
          env.DB,
          `UPDATE vehicles SET category_id = ?, manufacturer = ?, model = ?,
             serial_number = CASE WHEN ? <> '' THEN ? ELSE serial_number END,
             license_plate = CASE WHEN ? <> '' THEN ? ELSE license_plate END,
             external_key = COALESCE(?, external_key),
             supplier_id = COALESCE(?, supplier_id),
             expected_arrival = COALESCE(?, expected_arrival),
             odometer_km = COALESCE(?, odometer_km), operating_hours = COALESCE(?, operating_hours),
             location = CASE WHEN ? <> '' THEN ? ELSE location END,
             notes = CASE WHEN ? <> '' THEN ? ELSE notes END,
             updated_at = ? WHERE id = ?`,
          categoryId,
          cellString(d.manufacturer as CellValue),
          cellString(d.model as CellValue),
          cellString(d.serial_number as CellValue),
          cellString(d.serial_number as CellValue),
          cellString(d.license_plate as CellValue),
          cellString(d.license_plate as CellValue),
          cellString(d.external_key as CellValue) || null,
          supplierId,
          arrival,
          odometer,
          hours,
          cellString(d.location as CellValue),
          cellString(d.location as CellValue),
          cellString(d.notes as CellValue),
          cellString(d.notes as CellValue),
          ts,
          r.matched_vehicle_id,
        ),
        stmt(env.DB, "UPDATE import_rows SET action = 'update', errors = '[]', result_vehicle_id = ? WHERE job_id = ? AND row_number = ?", r.matched_vehicle_id, id, r.row_number),
        auditStatement(env.DB, { actor_id: user.id, actor_label: user.name, action: "vehicle.updated", entity_type: "vehicle", entity_id: r.matched_vehicle_id, vehicle_id: r.matched_vehicle_id, details: { source: "import", job_id: id, row: r.row_number }, ip }),
      );
    } else {
      created++;
      const vehicleId = uid();
      const internal = cellString(d.internal_number as CellValue) || reserved.shift()!;
      statements.push(
        stmt(
          env.DB,
          `INSERT INTO vehicles (id, internal_number, qr_code, external_key, category_id, manufacturer, model, serial_number, license_plate, status,
            odometer_km, operating_hours, location, notes, supplier_id, expected_arrival, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'announced',?,?,?,?,?,?,?,?,?)`,
          vehicleId,
          internal,
          newQrCode(),
          cellString(d.external_key as CellValue) || null,
          categoryId,
          cellString(d.manufacturer as CellValue),
          cellString(d.model as CellValue),
          cellString(d.serial_number as CellValue),
          cellString(d.license_plate as CellValue),
          odometer,
          hours,
          cellString(d.location as CellValue),
          cellString(d.notes as CellValue),
          supplierId,
          arrival,
          user.id,
          ts,
          ts,
        ),
        stmt(env.DB, "UPDATE import_rows SET action = 'create', errors = '[]', result_vehicle_id = ? WHERE job_id = ? AND row_number = ?", vehicleId, id, r.row_number),
        auditStatement(env.DB, { actor_id: user.id, actor_label: user.name, action: "vehicle.created", entity_type: "vehicle", entity_id: vehicleId, vehicle_id: vehicleId, details: { source: "import", job_id: id, row: r.row_number, internal_number: internal }, ip }),
      );
    }
  }
  statements.push(
    stmt(
      env.DB,
      "UPDATE import_jobs SET status = 'committed', committed_at = ?, created_count = ?, updated_count = ?, error_count = ?, valid_count = ? WHERE id = ?",
      ts,
      created,
      updated,
      errors.length,
      created + updated,
      id,
    ),
    auditStatement(env.DB, { actor_id: user.id, actor_label: user.name, action: "import.committed", entity_type: "import_job", entity_id: id, details: { created, updated, skipped: errors.length }, ip }),
  );
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  return getImportJob(env, id, true);
}

export function importTemplate(lang: Language): Uint8Array {
  const header = lang === "de"
    ? ["Interne Nummer", "Externer Schlüssel", "Kategorie", "Hersteller", "Modell", "Seriennummer", "Kennzeichen", "Lieferant", "Erwartete Ankunft", "Kilometerstand", "Betriebsstunden", "Standort", "Bemerkungen"]
    : ["Internal number", "External key", "Category", "Manufacturer", "Model", "Serial number", "License plate", "Supplier", "Expected arrival", "Odometer km", "Operating hours", "Location", "Notes"];
  const example = lang === "de"
    ? ["", "PO-2026-0815", "Transporter", "Mercedes-Benz", "Sprinter 317", "W1V9076351P123456", "", "Mercedes-Benz Vans", "2026-10-01", 12, "", "Halle 2", "Vorführfahrzeug"]
    : ["", "PO-2026-0815", "Van", "Mercedes-Benz", "Sprinter 317", "W1V9076351P123456", "", "Mercedes-Benz Vans", "2026-10-01", 12, "", "Hall 2", "Demo vehicle"];
  return writeXlsx("Import", [header, example], [16, 18, 16, 18, 18, 22, 14, 22, 16, 14, 16, 16, 30]);
}
