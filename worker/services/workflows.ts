import type { Condition, Language, ProtocolSnapshot, ProtocolType, Settings, Vehicle, VehicleStatus } from "@shared/types";
import { PROTOCOL_PREFIX, meterRequirements } from "@shared/domain";
import type {
  CheckInInput,
  CheckOutInput,
  CorrectionInput,
  DamageReportInput,
  DamageResolveInput,
  LoanCheckoutInput,
  LoanReturnInput,
  MaintenanceEndInput,
  MaintenanceStartInput,
} from "@shared/schemas";
import type { Env, SessionUser } from "../env";
import { all, nextSequence, now, one, stmt, uid } from "../lib/db";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors";
import { auditStatement } from "../lib/audit";
import { attachStatements, loadStaged, type MediaRow } from "./media";
import { getActiveLoan, getVehicle, getVehicleRow, type LoanRow, type VehicleRow } from "./vehicles";
import { withVehicleLock } from "./lock";
import { finalizeProtocol } from "./pdf";

export interface WorkflowCtx {
  env: Env;
  user: SessionUser;
  ip: string;
  lang: Language;
  settings: Settings;
  waitUntil: (p: Promise<unknown>) => void;
}

export interface WorkflowResult {
  vehicle: Vehicle;
  protocol_id: string;
  protocol_number: string;
  loan_id?: string;
}

interface DamageLine {
  description: string;
  severity: "minor" | "major" | "critical";
  photo_ids: string[];
}

interface Readings {
  odometer_km: number | null;
  operating_hours: number | null;
}

function validateReadings(v: VehicleRow, input: { odometer_km?: number | null; operating_hours?: number | null }, required: boolean): Readings {
  const req = meterRequirements(v.meter_mode);
  const odo = input.odometer_km ?? null;
  const hrs = input.operating_hours ?? null;
  if (!req.odometer) {
    if (odo != null) throw badRequest("odometer_not_applicable", { odometer_km: "not_applicable" });
  } else if (required && odo == null) {
    throw badRequest("odometer_required", { odometer_km: "required" });
  } else if (odo != null && v.odometer_km != null && odo < v.odometer_km) {
    throw badRequest("reading_decreased", { odometer_km: "decreased" }, { previous: v.odometer_km });
  }
  if (!req.hours) {
    if (hrs != null) throw badRequest("hours_not_applicable", { operating_hours: "not_applicable" });
  } else if (required && hrs == null) {
    throw badRequest("hours_required", { operating_hours: "required" });
  } else if (hrs != null && v.operating_hours != null && hrs < v.operating_hours) {
    throw badRequest("reading_decreased", { operating_hours: "decreased" }, { previous: v.operating_hours });
  }
  return { odometer_km: odo, operating_hours: hrs };
}

function assertStatus(v: VehicleRow, allowed: VehicleStatus[]) {
  if (!allowed.includes(v.status)) throw conflict("vehicle_status", { status: v.status });
}

async function loadEvidence(
  ctx: WorkflowCtx,
  photoIds: string[],
  signatureId: string | null | undefined,
  minPhotos: number,
  signatureRequired: boolean,
) {
  if (photoIds.length < minPhotos) throw badRequest("photos_required", { photo_ids: "min" }, { count: minPhotos });
  const photos = await loadStaged(ctx.env, photoIds, "photo", ctx.user.id);
  let signature: MediaRow | null = null;
  if (signatureId) {
    [signature] = await loadStaged(ctx.env, [signatureId], "signature", ctx.user.id);
  } else if (signatureRequired) {
    throw badRequest("signature_required", { signature_id: "required" });
  }
  return { photos, signature };
}

async function loadDamagePhotos(ctx: WorkflowCtx, damages: DamageLine[]): Promise<Map<number, MediaRow[]>> {
  // One lookup for every damage: 20 damages would otherwise be 20 queries.
  const rows = await loadStaged(
    ctx.env,
    damages.flatMap((d) => d.photo_ids),
    "photo",
    ctx.user.id,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const map = new Map<number, MediaRow[]>();
  damages.forEach((d, i) => map.set(i, d.photo_ids.map((id) => byId.get(id)!)));
  return map;
}

async function protocolNumber(env: Env, type: ProtocolType): Promise<string> {
  const seq = await nextSequence(env.DB, "protocol");
  return `${PROTOCOL_PREFIX[type]}-${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
}

interface ProtocolSpec {
  vehicle: VehicleRow;
  type: ProtocolType;
  statusAfter: VehicleStatus;
  readings: Readings;
  condition: Condition | null;
  notes: string;
  photos: MediaRow[];
  signature: MediaRow | null;
  damages: DamageLine[];
  damagePhotos: Map<number, MediaRow[]>;
  loanId?: string | null;
  companyId?: string | null;
  party?: ProtocolSnapshot["party"];
  loanSnapshot?: ProtocolSnapshot["loan"];
  extra?: Record<string, unknown>;
  vehicleUpdates?: Record<string, unknown>;
  extraStatements?: D1PreparedStatement[];
  // Statements that must exist before the protocol row (e.g. a loan the protocol references).
  preStatements?: D1PreparedStatement[];
  // Statements that need the protocol id (e.g. linking the loan back to its protocol).
  linkStatements?: (protocolId: string) => D1PreparedStatement[];
  auditAction: string;
  auditDetails?: Record<string, unknown>;
  sendCopyTo?: string[];
}

/** Writes protocol + vehicle update + evidence + damages + audit in one D1 batch, then queues PDF/e-mail. */
async function commitProtocol(ctx: WorkflowCtx, spec: ProtocolSpec): Promise<{ id: string; number: string }> {
  const { env, user } = ctx;
  const v = spec.vehicle;
  const id = uid();
  const number = await protocolNumber(env, spec.type);
  const ts = now();

  const damageIds = spec.damages.map(() => uid());
  const snapshot: ProtocolSnapshot = {
    vehicle: {
      id: v.id,
      internal_number: v.internal_number,
      qr_code: v.qr_code,
      manufacturer: v.manufacturer,
      model: v.model,
      license_plate: (spec.vehicleUpdates?.license_plate as string) ?? v.license_plate,
      serial_number: (spec.vehicleUpdates?.serial_number as string) ?? v.serial_number,
      status: spec.statusAfter,
      category_name: v.category_name,
      location: (spec.vehicleUpdates?.location as string) ?? v.location,
      meter_mode: v.meter_mode,
    },
    party: spec.party ?? null,
    loan: spec.loanSnapshot ?? null,
    readings: spec.readings,
    previous_readings: { odometer_km: v.odometer_km, operating_hours: v.operating_hours },
    damages: spec.damages.map((d) => ({ description: d.description, severity: d.severity })),
    media: [
      ...spec.photos.map((m) => ({ id: m.id, kind: m.kind, sha256: m.sha256, caption: m.caption })),
      ...(spec.signature ? [{ id: spec.signature.id, kind: "signature", sha256: spec.signature.sha256, caption: "" }] : []),
      ...[...spec.damagePhotos.values()].flat().map((m) => ({ id: m.id, kind: m.kind, sha256: m.sha256, caption: m.caption })),
    ],
    performed_by: { id: user.id, name: user.name, email: user.email },
    extra: spec.extra,
  };

  const statements: D1PreparedStatement[] = [
    ...(spec.preStatements ?? []),
    stmt(
      env.DB,
      `INSERT INTO protocols (id, number, type, vehicle_id, loan_id, company_id, performed_by, performed_at, odometer_km, operating_hours,
        condition, notes, status_before, status_after, snapshot, language, pdf_status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
      id,
      number,
      spec.type,
      v.id,
      spec.loanId ?? null,
      spec.companyId ?? null,
      user.id,
      ts,
      spec.readings.odometer_km,
      spec.readings.operating_hours,
      spec.condition,
      spec.notes,
      v.status,
      spec.statusAfter,
      JSON.stringify(snapshot),
      ctx.lang,
      ts,
    ),
  ];

  const updates: Record<string, unknown> = { status: spec.statusAfter, updated_at: ts, ...(spec.vehicleUpdates ?? {}) };
  if (spec.readings.odometer_km != null) updates.odometer_km = spec.readings.odometer_km;
  if (spec.readings.operating_hours != null) updates.operating_hours = spec.readings.operating_hours;
  statements.push(
    stmt(
      env.DB,
      `UPDATE vehicles SET ${Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ")} WHERE id = ?`,
      ...Object.values(updates),
      v.id,
    ),
  );

  statements.push(...attachStatements(env.DB, spec.photos, { vehicle_id: v.id, protocol_id: id }));
  if (spec.signature) statements.push(...attachStatements(env.DB, [spec.signature], { vehicle_id: v.id, protocol_id: id }));

  spec.damages.forEach((d, i) => {
    statements.push(
      stmt(
        env.DB,
        "INSERT INTO damages (id, vehicle_id, protocol_id, loan_id, description, severity, reported_by, reported_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        damageIds[i],
        v.id,
        id,
        spec.loanId ?? null,
        d.description,
        d.severity,
        user.id,
        ts,
        ts,
      ),
    );
    statements.push(...attachStatements(env.DB, spec.damagePhotos.get(i) ?? [], { vehicle_id: v.id, protocol_id: id, damage_id: damageIds[i] }));
  });

  statements.push(...(spec.extraStatements ?? []));
  statements.push(...(spec.linkStatements?.(id) ?? []));
  statements.push(
    auditStatement(env.DB, {
      actor_id: user.id,
      actor_label: user.name,
      action: spec.auditAction,
      entity_type: "protocol",
      entity_id: id,
      vehicle_id: v.id,
      details: { number, status_before: v.status, status_after: spec.statusAfter, ...(spec.auditDetails ?? {}) },
      ip: ctx.ip,
    }),
  );

  await env.DB.batch(statements);
  ctx.waitUntil(finalizeProtocol(env, id, spec.sendCopyTo ?? []));
  return { id, number };
}

function statusFromCondition(condition: Condition, fallback: VehicleStatus = "available"): VehicleStatus {
  if (condition === "damaged") return "damaged";
  if (condition === "maintenance") return "maintenance";
  return fallback;
}

function copyRecipients(...emails: (string | null | undefined)[]): string[] {
  return emails.map((e) => (e ?? "").trim()).filter((e) => e.includes("@"));
}

async function result(ctx: WorkflowCtx, vehicleId: string, p: { id: string; number: string }, loanId?: string): Promise<WorkflowResult> {
  return { vehicle: await getVehicle(ctx.env, vehicleId, ctx.user.role), protocol_id: p.id, protocol_number: p.number, loan_id: loanId };
}

// ---------------------------------------------------------------------------
// Check-in (delivery from manufacturer)
// ---------------------------------------------------------------------------
export function checkIn(ctx: WorkflowCtx, vehicleId: string, input: CheckInInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["announced"]);
    const readings = validateReadings(v, input, false);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, ctx.settings.min_photos_check_in, ctx.settings.signature_required_check_in);
    if (input.condition === "damaged" && input.damages.length === 0) throw badRequest("damage_description_required", { damages: "required" });
    const damagePhotos = await loadDamagePhotos(ctx, input.damages);
    const supplierId = input.supplier_id ?? v.supplier_id;
    const supplier = supplierId ? await one<{ name: string; company_type: string }>(ctx.env.DB, "SELECT name, company_type FROM companies WHERE id = ?", supplierId) : null;
    if (supplierId && !supplier) throw badRequest("invalid_reference", { supplier_id: "not_found" });
    if (supplier && supplier.company_type !== "supplier") throw badRequest("company_type", { supplier_id: "type" });

    const vehicleUpdates: Record<string, unknown> = {};
    if (input.location) vehicleUpdates.location = input.location;
    if (input.supplier_id !== undefined) vehicleUpdates.supplier_id = input.supplier_id;
    if (input.license_plate !== undefined) vehicleUpdates.license_plate = input.license_plate;
    if (input.serial_number !== undefined) vehicleUpdates.serial_number = input.serial_number;

    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "check_in",
      statusAfter: statusFromCondition(input.condition),
      readings,
      condition: input.condition,
      notes: input.notes,
      photos,
      signature,
      damages: input.damages,
      damagePhotos,
      companyId: supplierId,
      party: supplier ? { name: supplier.name, company: supplier.name } : null,
      vehicleUpdates,
      auditAction: "vehicle.checked_in",
      sendCopyTo: copyRecipients(input.send_copy_to),
    });
    return result(ctx, vehicleId, p);
  });
}

// ---------------------------------------------------------------------------
// Loan checkout
// ---------------------------------------------------------------------------
export function loanCheckout(ctx: WorkflowCtx, vehicleId: string, input: LoanCheckoutInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["available"]);
    if (await getActiveLoan(ctx.env, vehicleId)) throw conflict("active_loan");
    if (new Date(input.expected_return_at).getTime() <= Date.now()) throw badRequest("expected_return_past", { expected_return_at: "past" });
    const readings = validateReadings(v, input, true);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, ctx.settings.min_photos_loan, false);

    let company: { name: string; company_type: string } | null = null;
    if (input.company_id) {
      company = await one(ctx.env.DB, "SELECT name, company_type FROM companies WHERE id = ?", input.company_id);
      if (!company) throw badRequest("invalid_reference", { company_id: "not_found" });
      if (company.company_type === "supplier") throw badRequest("company_type", { company_id: "type" });
    }
    if (input.driver_id) {
      const driver = await one<{ id: string }>(ctx.env.DB, "SELECT id FROM drivers WHERE id = ?", input.driver_id);
      if (!driver) throw badRequest("invalid_reference", { driver_id: "not_found" });
    }

    const loanId = uid();
    const ts = now();
    const loanStatement = stmt(
      ctx.env.DB,
      `INSERT INTO loans (id, vehicle_id, company_id, driver_id, borrower_name, borrower_phone, borrower_email, status, checked_out_at, expected_return_at,
        checkout_odometer_km, checkout_operating_hours, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`,
      loanId,
      v.id,
      input.company_id ?? null,
      input.driver_id ?? null,
      input.borrower_name,
      input.borrower_phone,
      input.borrower_email,
      ts,
      input.expected_return_at,
      readings.odometer_km,
      readings.operating_hours,
      ctx.user.id,
      ts,
      ts,
    );

    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "loan_checkout",
      statusAfter: "loaned",
      readings,
      condition: null,
      notes: input.notes,
      photos,
      signature,
      damages: [],
      damagePhotos: new Map(),
      loanId,
      companyId: input.company_id ?? null,
      party: { name: input.borrower_name, phone: input.borrower_phone, email: input.borrower_email, company: company?.name ?? null },
      loanSnapshot: { checked_out_at: ts, expected_return_at: input.expected_return_at },
      preStatements: [loanStatement],
      linkStatements: (protocolId) => [stmt(ctx.env.DB, "UPDATE loans SET checkout_protocol_id = ? WHERE id = ?", protocolId, loanId)],
      auditAction: "loan.checked_out",
      auditDetails: { loan_id: loanId, borrower: input.borrower_name, expected_return_at: input.expected_return_at },
      sendCopyTo: copyRecipients(input.borrower_email, input.send_copy_to),
    });
    return result(ctx, vehicleId, p, loanId);
  });
}

// ---------------------------------------------------------------------------
// Loan return
// ---------------------------------------------------------------------------
export function loanReturn(ctx: WorkflowCtx, vehicleId: string, input: LoanReturnInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["loaned"]);
    const loan = await getActiveLoan(ctx.env, vehicleId);
    if (!loan) throw conflict("no_active_loan");
    const readings = validateReadings(v, input, true);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, ctx.settings.min_photos_return, ctx.settings.signature_required_return);
    if (input.condition === "damaged" && input.damages.length === 0) throw badRequest("damage_description_required", { damages: "required" });
    const damagePhotos = await loadDamagePhotos(ctx, input.damages);
    const ts = now();

    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "loan_return",
      statusAfter: statusFromCondition(input.condition),
      readings,
      condition: input.condition,
      notes: input.notes,
      photos,
      signature,
      damages: input.damages,
      damagePhotos,
      loanId: loan.id,
      companyId: loan.company_id,
      party: { name: loan.borrower_name, phone: loan.borrower_phone, email: loan.borrower_email, company: loan.company_name },
      loanSnapshot: { checked_out_at: loan.checked_out_at, expected_return_at: loan.expected_return_at, actual_return_at: ts },
      extra: {
        checkout_readings: { odometer_km: loan.checkout_odometer_km, operating_hours: loan.checkout_operating_hours },
        overdue: loan.expected_return_at < ts,
      },
      extraStatements: [
        stmt(
          ctx.env.DB,
          "UPDATE loans SET status = 'returned', actual_return_at = ?, return_odometer_km = ?, return_operating_hours = ?, returned_by = ?, updated_at = ? WHERE id = ?",
          ts,
          readings.odometer_km,
          readings.operating_hours,
          ctx.user.id,
          ts,
          loan.id,
        ),
      ],
      linkStatements: (protocolId) => [stmt(ctx.env.DB, "UPDATE loans SET return_protocol_id = ? WHERE id = ?", protocolId, loan.id)],
      auditAction: "loan.returned",
      auditDetails: { loan_id: loan.id, condition: input.condition, damages: input.damages.length },
      sendCopyTo: copyRecipients(loan.borrower_email, input.send_copy_to),
    });
    return result(ctx, vehicleId, p, loan.id);
  });
}

// ---------------------------------------------------------------------------
// Check-out (back to manufacturer)
// ---------------------------------------------------------------------------
export function checkOut(ctx: WorkflowCtx, vehicleId: string, input: CheckOutInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["available", "damaged", "maintenance"]);
    if (await getActiveLoan(ctx.env, vehicleId)) throw conflict("active_loan");
    const readings = validateReadings(v, input, true);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, ctx.settings.min_photos_check_out, ctx.settings.signature_required_check_out);
    if (input.condition === "damaged" && input.damages.length === 0) throw badRequest("damage_description_required", { damages: "required" });
    const damagePhotos = await loadDamagePhotos(ctx, input.damages);
    const companyId = input.company_id ?? v.supplier_id;
    const company = companyId ? await one<{ name: string; company_type: string }>(ctx.env.DB, "SELECT name, company_type FROM companies WHERE id = ?", companyId) : null;
    if (companyId && !company) throw badRequest("invalid_reference", { company_id: "not_found" });
    const ts = now();
    const statusAfter: VehicleStatus = input.archive ? "archived" : "checked_out";
    const vehicleUpdates: Record<string, unknown> = { return_due: null };
    if (input.archive) {
      vehicleUpdates.archived_at = ts;
      vehicleUpdates.archive_reason = "checked_out";
    }

    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "check_out",
      statusAfter,
      readings,
      condition: input.condition,
      notes: input.notes,
      photos,
      signature,
      damages: input.damages,
      damagePhotos,
      companyId,
      party: { name: input.recipient_name || company?.name || "", company: company?.name ?? null },
      vehicleUpdates,
      auditAction: "vehicle.checked_out",
      auditDetails: { recipient: input.recipient_name, archived: input.archive },
      sendCopyTo: copyRecipients(input.send_copy_to),
    });
    return result(ctx, vehicleId, p);
  });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------
export function maintenanceStart(ctx: WorkflowCtx, vehicleId: string, input: MaintenanceStartInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["available", "damaged"]);
    if (await getActiveLoan(ctx.env, vehicleId)) throw conflict("active_loan");
    const readings = validateReadings(v, input, false);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, 0, false);
    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "maintenance_start",
      statusAfter: "maintenance",
      readings,
      condition: "maintenance",
      notes: [input.reason, input.notes].filter(Boolean).join("\n"),
      photos,
      signature,
      damages: [],
      damagePhotos: new Map(),
      extra: { reason: input.reason },
      auditAction: "maintenance.started",
      auditDetails: { reason: input.reason },
    });
    return result(ctx, vehicleId, p);
  });
}

export function maintenanceEnd(ctx: WorkflowCtx, vehicleId: string, input: MaintenanceEndInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["maintenance"]);
    const readings = validateReadings(v, input, false);
    const { photos, signature } = await loadEvidence(ctx, input.photo_ids, input.signature_id, 0, false);
    const ts = now();
    // Only count damages that are really open for this vehicle, otherwise an unknown or
    // already resolved id would make the vehicle look repaired while damages remain.
    const open = await all<{ id: string }>(ctx.env.DB, "SELECT id FROM damages WHERE vehicle_id = ? AND resolved_at IS NULL", v.id);
    const openIds = new Set(open.map((d) => d.id));
    const unknown = input.resolved_damage_ids.filter((d) => !openIds.has(d));
    if (unknown.length) throw badRequest("damage_not_open", { resolved_damage_ids: "unknown" });
    const resolvedIds = [...new Set(input.resolved_damage_ids)];
    const resolveStatements = resolvedIds.map((d) =>
      stmt(
        ctx.env.DB,
        "UPDATE damages SET resolved_at = ?, resolved_by = ?, resolution_notes = ? WHERE id = ? AND vehicle_id = ? AND resolved_at IS NULL",
        ts,
        ctx.user.id,
        input.notes,
        d,
        v.id,
      ),
    );
    const remaining = openIds.size - resolvedIds.length;
    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "maintenance_end",
      statusAfter: remaining > 0 ? "damaged" : "available",
      readings,
      condition: remaining > 0 ? "damaged" : "ok",
      notes: input.notes,
      photos,
      signature,
      damages: [],
      damagePhotos: new Map(),
      extra: { resolved_damage_ids: resolvedIds },
      extraStatements: resolveStatements,
      auditAction: "maintenance.ended",
      auditDetails: { resolved: resolvedIds.length },
    });
    return result(ctx, vehicleId, p);
  });
}

// ---------------------------------------------------------------------------
// Damages
// ---------------------------------------------------------------------------
export function reportDamage(ctx: WorkflowCtx, vehicleId: string, input: DamageReportInput): Promise<Vehicle> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, ["available", "loaned", "damaged", "maintenance"]);
    const photos = await loadStaged(ctx.env, input.photo_ids, "photo", ctx.user.id);
    const loan = await getActiveLoan(ctx.env, vehicleId);
    const id = uid();
    const ts = now();
    const statements: D1PreparedStatement[] = [
      stmt(
        ctx.env.DB,
        "INSERT INTO damages (id, vehicle_id, loan_id, description, severity, reported_by, reported_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
        id,
        v.id,
        loan?.id ?? null,
        input.description,
        input.severity,
        ctx.user.id,
        ts,
        ts,
      ),
      ...attachStatements(ctx.env.DB, photos, { vehicle_id: v.id, damage_id: id }),
    ];
    const newStatus: VehicleStatus = input.mark_vehicle_damaged && v.status === "available" ? "damaged" : v.status;
    if (newStatus !== v.status) statements.push(stmt(ctx.env.DB, "UPDATE vehicles SET status = ?, updated_at = ? WHERE id = ?", newStatus, ts, v.id));
    statements.push(
      auditStatement(ctx.env.DB, {
        actor_id: ctx.user.id,
        actor_label: ctx.user.name,
        action: "damage.reported",
        entity_type: "damage",
        entity_id: id,
        vehicle_id: v.id,
        details: { description: input.description, severity: input.severity, status_before: v.status, status_after: newStatus, photos: photos.length },
        ip: ctx.ip,
      }),
    );
    await ctx.env.DB.batch(statements);
    return getVehicle(ctx.env, vehicleId, ctx.user.role);
  });
}

export function resolveDamage(ctx: WorkflowCtx, vehicleId: string, damageId: string, input: DamageResolveInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    const damage = await one<{ id: string; description: string; severity: "minor" | "major" | "critical"; resolved_at: string | null }>(
      ctx.env.DB,
      "SELECT id, description, severity, resolved_at FROM damages WHERE id = ? AND vehicle_id = ?",
      damageId,
      vehicleId,
    );
    if (!damage) throw notFound();
    if (damage.resolved_at) throw conflict("vehicle_status", { status: v.status });
    const photos = await loadStaged(ctx.env, input.photo_ids, "photo", ctx.user.id);
    const ts = now();
    const remaining = Number(v.open_damage_count) - 1;
    const statusAfter: VehicleStatus = v.status === "damaged" && remaining <= 0 ? "available" : v.status;
    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "damage_resolved",
      statusAfter,
      readings: { odometer_km: null, operating_hours: null },
      condition: statusAfter === "available" ? "ok" : null,
      notes: input.resolution_notes,
      photos,
      signature: null,
      damages: [],
      damagePhotos: new Map(),
      extra: { resolved_damage: { id: damage.id, description: damage.description, severity: damage.severity } },
      extraStatements: [
        stmt(ctx.env.DB, "UPDATE damages SET resolved_at = ?, resolved_by = ?, resolution_notes = ? WHERE id = ?", ts, ctx.user.id, input.resolution_notes, damage.id),
      ],
      auditAction: "damage.resolved",
      auditDetails: { damage_id: damage.id },
    });
    return result(ctx, vehicleId, p);
  });
}

// ---------------------------------------------------------------------------
// Admin status correction / archive
// ---------------------------------------------------------------------------
export function correctStatus(ctx: WorkflowCtx, vehicleId: string, input: CorrectionInput): Promise<WorkflowResult> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    if (v.status === input.status) throw conflict("vehicle_status", { status: v.status });
    const loan = await getActiveLoan(ctx.env, vehicleId);
    const extraStatements: D1PreparedStatement[] = [];
    const ts = now();
    if (loan && input.status !== "loaned") {
      if (!input.cancel_active_loan) throw conflict("active_loan");
      extraStatements.push(stmt(ctx.env.DB, "UPDATE loans SET status = 'cancelled', updated_at = ?, returned_by = ? WHERE id = ?", ts, ctx.user.id, loan.id));
    }
    if (!loan && input.status === "loaned") throw conflict("no_active_loan");
    const vehicleUpdates: Record<string, unknown> = {};
    if (input.status === "archived") {
      vehicleUpdates.archived_at = ts;
      vehicleUpdates.archive_reason = input.reason;
    } else if (v.status === "archived") {
      vehicleUpdates.archived_at = null;
      vehicleUpdates.archive_reason = "";
    }
    const p = await commitProtocol(ctx, {
      vehicle: v,
      type: "status_correction",
      statusAfter: input.status,
      readings: { odometer_km: null, operating_hours: null },
      condition: null,
      notes: input.reason,
      photos: [],
      signature: null,
      damages: [],
      damagePhotos: new Map(),
      extra: { reason: input.reason, cancelled_loan_id: loan && input.status !== "loaned" ? loan.id : null },
      vehicleUpdates,
      extraStatements,
      auditAction: "vehicle.status_corrected",
      auditDetails: { reason: input.reason },
    });
    return result(ctx, vehicleId, p);
  });
}

export function archiveVehicle(ctx: WorkflowCtx, vehicleId: string, reason: string, unarchive = false): Promise<Vehicle> {
  return withVehicleLock(ctx.env, vehicleId, async () => {
    const v = await getVehicleRow(ctx.env, vehicleId);
    assertStatus(v, unarchive ? ["archived"] : ["checked_out"]);
    const ts = now();
    const status: VehicleStatus = unarchive ? "checked_out" : "archived";
    await ctx.env.DB.batch([
      stmt(
        ctx.env.DB,
        "UPDATE vehicles SET status = ?, archived_at = ?, archive_reason = ?, updated_at = ? WHERE id = ?",
        status,
        unarchive ? null : ts,
        unarchive ? "" : reason,
        ts,
        v.id,
      ),
      auditStatement(ctx.env.DB, {
        actor_id: ctx.user.id,
        actor_label: ctx.user.name,
        action: unarchive ? "vehicle.unarchived" : "vehicle.archived",
        entity_type: "vehicle",
        entity_id: v.id,
        vehicle_id: v.id,
        details: { reason },
        ip: ctx.ip,
      }),
    ]);
    return getVehicle(ctx.env, vehicleId, ctx.user.role);
  });
}

export function assertLoanActive(loan: LoanRow | null): LoanRow {
  if (!loan || loan.status !== "active") throw new ApiError(409, "loan_not_active");
  return loan;
}
