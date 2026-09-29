import type { Loan, MeterMode, Role, Vehicle, VehicleStatus, VehicleSummary } from "@shared/types";
import { VEHICLE_STATUSES } from "@shared/types";
import { formatInternalNumber, randomQrCode, vehicleCapabilities } from "@shared/domain";
import type { VehicleCreateInput, VehicleUpdateInput } from "@shared/schemas";
import type { Env, SessionUser } from "../env";
import { all, nextSequence, now, one, paginate, parsePage, stmt, uid } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { randomBytes } from "../lib/crypto";
import { auditStatement } from "../lib/audit";

export interface VehicleRow {
  id: string;
  internal_number: string;
  qr_code: string;
  external_key: string | null;
  category_id: string;
  category_name: string;
  meter_mode: MeterMode;
  manufacturer: string;
  model: string;
  serial_number: string;
  license_plate: string;
  status: VehicleStatus;
  odometer_km: number | null;
  operating_hours: number | null;
  location: string;
  notes: string;
  supplier_id: string | null;
  supplier_name: string | null;
  expected_arrival: string | null;
  return_due: string | null;
  archived_at: string | null;
  archive_reason: string;
  created_at: string;
  updated_at: string;
  open_damage_count: number;
}

const KNOWN_STATUSES = new Set<string>(VEHICLE_STATUSES);

export const VEHICLE_SELECT = `
  SELECT v.*, c.name AS category_name, c.meter_mode, s.name AS supplier_name,
    (SELECT COUNT(*) FROM damages d WHERE d.vehicle_id = v.id AND d.resolved_at IS NULL) AS open_damage_count
  FROM vehicles v
  JOIN categories c ON c.id = v.category_id
  LEFT JOIN companies s ON s.id = v.supplier_id`;

export function toSummary(v: VehicleRow): VehicleSummary {
  return {
    id: v.id,
    internal_number: v.internal_number,
    qr_code: v.qr_code,
    manufacturer: v.manufacturer,
    model: v.model,
    license_plate: v.license_plate,
    serial_number: v.serial_number,
    status: v.status,
    category_name: v.category_name,
  };
}

export interface LoanRow {
  id: string;
  vehicle_id: string;
  company_id: string | null;
  company_name: string | null;
  driver_id: string | null;
  borrower_name: string;
  borrower_phone: string;
  borrower_email: string;
  status: "active" | "returned" | "cancelled";
  checked_out_at: string;
  expected_return_at: string;
  actual_return_at: string | null;
  checkout_odometer_km: number | null;
  checkout_operating_hours: number | null;
  return_odometer_km: number | null;
  return_operating_hours: number | null;
  checkout_protocol_id: string | null;
  return_protocol_id: string | null;
}

export const LOAN_SELECT = `SELECT l.*, co.name AS company_name FROM loans l LEFT JOIN companies co ON co.id = l.company_id`;

export function toLoan(l: LoanRow): Loan {
  return {
    ...l,
    overdue: l.status === "active" && l.expected_return_at < now(),
  };
}

export async function getVehicleRow(env: Env, id: string): Promise<VehicleRow> {
  const v = await one<VehicleRow>(env.DB, `${VEHICLE_SELECT} WHERE v.id = ?`, id);
  if (!v) throw notFound();
  return v;
}

/**
 * Looks up a vehicle by its QR code. Signed-in users may also use the internal
 * number (typed into the scan page); the public sticker page must not, or the
 * sequential numbers would make every vehicle enumerable without a login.
 */
export async function getVehicleByQr(env: Env, qr: string, allowInternalNumber = true): Promise<VehicleRow | null> {
  return allowInternalNumber
    ? one<VehicleRow>(env.DB, `${VEHICLE_SELECT} WHERE v.qr_code = ? OR v.internal_number = ? COLLATE NOCASE`, qr, qr)
    : one<VehicleRow>(env.DB, `${VEHICLE_SELECT} WHERE v.qr_code = ?`, qr);
}

export async function getActiveLoan(env: Env, vehicleId: string): Promise<LoanRow | null> {
  return one<LoanRow>(env.DB, `${LOAN_SELECT} WHERE l.vehicle_id = ? AND l.status = 'active'`, vehicleId);
}

export async function getVehicle(env: Env, id: string, role: Role): Promise<Vehicle> {
  const v = await getVehicleRow(env, id);
  const loan = await getActiveLoan(env, id);
  return toVehicle(v, loan, role);
}

export function toVehicle(v: VehicleRow, loan: LoanRow | null, role: Role): Vehicle {
  return {
    ...toSummary(v),
    external_key: v.external_key,
    category_id: v.category_id,
    meter_mode: v.meter_mode,
    odometer_km: v.odometer_km,
    operating_hours: v.operating_hours,
    location: v.location,
    notes: v.notes,
    supplier_id: v.supplier_id,
    supplier_name: v.supplier_name,
    expected_arrival: v.expected_arrival,
    return_due: v.return_due,
    archived_at: v.archived_at,
    archive_reason: v.archive_reason,
    created_at: v.created_at,
    updated_at: v.updated_at,
    open_damage_count: Number(v.open_damage_count ?? 0),
    active_loan: loan ? toLoan(loan) : null,
    capabilities: vehicleCapabilities(role, {
      status: v.status,
      has_active_loan: !!loan,
      open_damage_count: Number(v.open_damage_count ?? 0),
    }),
  };
}

export async function listVehicles(env: Env, url: URL) {
  const page = parsePage(url);
  const where: string[] = [];
  const params: unknown[] = [];
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status");
  const category = url.searchParams.get("category_id");
  const includeArchived = url.searchParams.get("include_archived") === "1";
  if (q) {
    where.push(
      "(v.internal_number LIKE ? OR v.manufacturer LIKE ? OR v.model LIKE ? OR v.serial_number LIKE ? OR v.license_plate LIKE ? OR v.qr_code LIKE ? OR v.location LIKE ?)",
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const statusList = status ? status.split(",").filter((s) => KNOWN_STATUSES.has(s)) : [];
  if (statusList.length) {
    where.push(`v.status IN (${statusList.map(() => "?").join(",")})`);
    params.push(...statusList);
  } else if (!includeArchived) {
    where.push("v.status <> 'archived'");
  }
  if (category) {
    where.push("v.category_id = ?");
    params.push(category);
  }
  const sql = `${VEHICLE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""}`;
  const sort = url.searchParams.get("sort") ?? "updated";
  const orderBy =
    sort === "number" ? "v.internal_number" : sort === "status" ? "v.status, v.updated_at DESC" : "v.updated_at DESC";
  const res = await paginate<VehicleRow>(env.DB, sql, params, orderBy, page);
  return { ...res, results: res.results.map(toSummaryWithMeta) };
}

function toSummaryWithMeta(v: VehicleRow) {
  return {
    ...toSummary(v),
    location: v.location,
    open_damage_count: Number(v.open_damage_count ?? 0),
    expected_arrival: v.expected_arrival,
    return_due: v.return_due,
    updated_at: v.updated_at,
  };
}

async function assertUnique(env: Env, field: "internal_number" | "serial_number" | "license_plate" | "external_key", value: string, excludeId?: string) {
  if (!value) return;
  const row = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM vehicles WHERE ${field} = ? COLLATE NOCASE${excludeId ? " AND id <> ?" : ""}`,
    ...(excludeId ? [value, excludeId] : [value]),
  );
  if (row) {
    if (field === "internal_number") throw conflict("duplicate_number");
    if (field === "serial_number") throw conflict("duplicate_serial");
    if (field === "license_plate") throw conflict("duplicate_plate");
    throw conflict("duplicate_number");
  }
}

export async function allocateInternalNumber(env: Env): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const n = formatInternalNumber(await nextSequence(env.DB, "vehicle"));
    const exists = await one(env.DB, "SELECT 1 AS x FROM vehicles WHERE internal_number = ?", n);
    if (!exists) return n;
  }
  throw new Error("could not allocate internal number");
}

export function newQrCode(): string {
  return randomQrCode(randomBytes);
}

/** Fails with a readable 400 instead of an opaque FOREIGN KEY error from D1. */
async function assertReference(env: Env, table: "categories" | "companies", id: string | null | undefined, field: string) {
  if (!id) return;
  const row = await one<{ id: string }>(env.DB, `SELECT id FROM ${table} WHERE id = ?`, id);
  if (!row) throw badRequest("invalid_reference", { [field]: "not_found" });
}

export async function createVehicle(env: Env, user: SessionUser, input: VehicleCreateInput, ip: string, source = "manual"): Promise<Vehicle> {
  await assertReference(env, "categories", input.category_id, "category_id");
  await assertReference(env, "companies", input.supplier_id, "supplier_id");
  const internal = input.internal_number || (await allocateInternalNumber(env));
  await assertUnique(env, "internal_number", internal);
  await assertUnique(env, "serial_number", input.serial_number);
  await assertUnique(env, "license_plate", input.license_plate);
  if (input.external_key) await assertUnique(env, "external_key", input.external_key);
  const id = uid();
  const ts = now();
  const qr = newQrCode();
  await env.DB.batch([
    stmt(
      env.DB,
      `INSERT INTO vehicles (id, internal_number, qr_code, external_key, category_id, manufacturer, model, serial_number, license_plate, status,
        odometer_km, operating_hours, location, notes, supplier_id, expected_arrival, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'announced',?,?,?,?,?,?,?,?,?)`,
      id,
      internal,
      qr,
      input.external_key || null,
      input.category_id,
      input.manufacturer,
      input.model,
      input.serial_number,
      input.license_plate,
      input.odometer_km ?? null,
      input.operating_hours ?? null,
      input.location,
      input.notes,
      input.supplier_id ?? null,
      input.expected_arrival || null,
      user.id,
      ts,
      ts,
    ),
    auditStatement(env.DB, {
      actor_id: user.id,
      actor_label: user.name,
      action: "vehicle.created",
      entity_type: "vehicle",
      entity_id: id,
      vehicle_id: id,
      details: { internal_number: internal, source },
      ip,
    }),
  ]);
  return getVehicle(env, id, user.role);
}

export async function updateVehicle(env: Env, user: SessionUser, id: string, input: VehicleUpdateInput, ip: string): Promise<Vehicle> {
  const current = await getVehicleRow(env, id);
  const changes: Record<string, unknown> = {};
  const fields: (keyof VehicleUpdateInput)[] = [
    "internal_number",
    "external_key",
    "category_id",
    "manufacturer",
    "model",
    "serial_number",
    "license_plate",
    "location",
    "notes",
    "supplier_id",
    "expected_arrival",
    "return_due",
    "odometer_km",
    "operating_hours",
  ];
  for (const f of fields) {
    const v = input[f];
    if (v === undefined) continue;
    const normalized = v === "" && (f === "external_key" || f === "expected_arrival" || f === "return_due") ? null : v;
    if ((current as unknown as Record<string, unknown>)[f] !== normalized) changes[f] = normalized;
  }
  if (typeof changes.category_id === "string") await assertReference(env, "categories", changes.category_id, "category_id");
  if (typeof changes.supplier_id === "string") await assertReference(env, "companies", changes.supplier_id, "supplier_id");
  if (typeof changes.internal_number === "string") await assertUnique(env, "internal_number", changes.internal_number, id);
  if (typeof changes.serial_number === "string") await assertUnique(env, "serial_number", changes.serial_number, id);
  if (typeof changes.license_plate === "string") await assertUnique(env, "license_plate", changes.license_plate, id);
  if (typeof changes.external_key === "string") await assertUnique(env, "external_key", changes.external_key, id);
  if (Object.keys(changes).length === 0) return getVehicle(env, id, user.role);

  const setSql = Object.keys(changes)
    .map((k) => `${k} = ?`)
    .join(", ");
  await env.DB.batch([
    stmt(env.DB, `UPDATE vehicles SET ${setSql}, updated_at = ? WHERE id = ?`, ...Object.values(changes), now(), id),
    auditStatement(env.DB, {
      actor_id: user.id,
      actor_label: user.name,
      action: "vehicle.updated",
      entity_type: "vehicle",
      entity_id: id,
      vehicle_id: id,
      details: { changes },
      ip,
    }),
  ]);
  return getVehicle(env, id, user.role);
}

export async function listLoansForVehicle(env: Env, vehicleId: string): Promise<Loan[]> {
  const rows = await all<LoanRow>(env.DB, `${LOAN_SELECT} WHERE l.vehicle_id = ? ORDER BY l.checked_out_at DESC LIMIT 50`, vehicleId);
  return rows.map(toLoan);
}
