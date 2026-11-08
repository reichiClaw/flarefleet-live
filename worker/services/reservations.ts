import type { Language, Reservation, VehicleStatus, VehicleSummary } from "@shared/types";
import type { ReservationCreateInput } from "@shared/schemas";
import type { Env, SessionUser } from "../env";
import { all, now, one, paginate, parsePage, stmt, uid } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { auditStatement } from "../lib/audit";
import { withVehicleLock } from "./lock";

const SCOPES = new Set(["upcoming", "all", "planned", "fulfilled", "cancelled", "expired"]);

export interface ReservationRow {
  id: string;
  vehicle_id: string;
  company_id: string | null;
  company_name: string | null;
  driver_id: string | null;
  borrower_name: string;
  borrower_phone: string;
  borrower_email: string;
  starts_at: string;
  ends_at: string;
  notes: string;
  status: Reservation["status"];
  loan_id: string | null;
  created_by: string;
  created_by_name: string | null;
  close_reason: string;
  created_at: string;
}

const RESERVATION_SELECT = `
  SELECT r.*, co.name AS company_name, u.name AS created_by_name
  FROM reservations r
  LEFT JOIN companies co ON co.id = r.company_id
  LEFT JOIN users u ON u.id = r.created_by`;

const WITH_VEHICLE = `
  SELECT r.*, co.name AS company_name, u.name AS created_by_name,
         v.internal_number, v.manufacturer, v.model, v.license_plate, v.serial_number, v.qr_code,
         v.status AS vehicle_status, c.name AS category_name
  FROM reservations r
  LEFT JOIN companies co ON co.id = r.company_id
  LEFT JOIN users u ON u.id = r.created_by
  JOIN vehicles v ON v.id = r.vehicle_id
  JOIN categories c ON c.id = v.category_id`;

type ReservationWithVehicleRow = ReservationRow & {
  internal_number: string;
  manufacturer: string;
  model: string;
  license_plate: string;
  serial_number: string;
  qr_code: string;
  vehicle_status: VehicleSummary["status"];
  category_name: string;
};

export function toReservation(r: ReservationRow, ts = now()): Reservation {
  return { ...r, due: r.status === "planned" && r.starts_at <= ts && r.ends_at >= ts };
}

function withVehicle(r: ReservationWithVehicleRow, ts: string): Reservation {
  const { internal_number, manufacturer, model, license_plate, serial_number, qr_code, category_name, vehicle_status, ...rest } = r;
  return {
    ...toReservation(rest as ReservationRow, ts),
    vehicle: { id: r.vehicle_id, internal_number, manufacturer, model, license_plate, serial_number, qr_code, category_name, status: vehicle_status },
  };
}

/** Planned reservations of this vehicle that overlap [from, to). */
export async function overlapping(env: Env, vehicleId: string, from: string, to: string, excludeId?: string): Promise<ReservationRow[]> {
  return all<ReservationRow>(
    env.DB,
    `${RESERVATION_SELECT} WHERE r.vehicle_id = ? AND r.status = 'planned' AND r.starts_at < ? AND r.ends_at > ?${excludeId ? " AND r.id <> ?" : ""} ORDER BY r.starts_at`,
    ...(excludeId ? [vehicleId, to, from, excludeId] : [vehicleId, to, from]),
  );
}

export async function getReservation(env: Env, id: string): Promise<ReservationRow> {
  const r = await one<ReservationRow>(env.DB, `${RESERVATION_SELECT} WHERE r.id = ?`, id);
  if (!r) throw notFound();
  return r;
}

export function formatWindow(r: { starts_at: string; ends_at: string }, lang: Language): { from: string; to: string } {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
  return { from: fmt(r.starts_at), to: fmt(r.ends_at) };
}

export async function listReservations(env: Env, url: URL) {
  const page = parsePage(url);
  const ts = now();
  const where: string[] = [];
  const params: unknown[] = [];
  const requested = url.searchParams.get("scope") ?? "upcoming";
  const scope = SCOPES.has(requested) ? requested : "upcoming";
  const vehicleId = url.searchParams.get("vehicle_id");
  const q = url.searchParams.get("q")?.trim();
  if (vehicleId) {
    where.push("r.vehicle_id = ?");
    params.push(vehicleId);
  }
  if (q) {
    where.push("(r.borrower_name LIKE ? OR co.name LIKE ? OR v.internal_number LIKE ? OR v.manufacturer LIKE ? OR v.model LIKE ? OR v.license_plate LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (scope === "upcoming") {
    where.push("r.status = 'planned' AND r.ends_at >= ?");
    params.push(ts);
  } else if (scope !== "all") {
    where.push("r.status = ?");
    params.push(scope);
  }
  const sql = `${WITH_VEHICLE}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const res = await paginate<ReservationWithVehicleRow>(env.DB, sql, params, scope === "upcoming" ? "r.starts_at" : "r.starts_at DESC", page);
  return { ...res, results: res.results.map((r) => withVehicle(r, ts)) };
}

/**
 * Planned windows come soonest first, because callers treat the first row as the
 * next hand-over; the full list is a history and reads newest first.
 */
export async function listForVehicle(env: Env, vehicleId: string, onlyPlanned = false): Promise<Reservation[]> {
  const ts = now();
  const rows = await all<ReservationRow>(
    env.DB,
    `${RESERVATION_SELECT} WHERE r.vehicle_id = ?${onlyPlanned ? " AND r.status = 'planned' AND r.ends_at >= ?" : ""} ORDER BY ${onlyPlanned ? "r.starts_at" : "r.starts_at DESC"} LIMIT 50`,
    ...(onlyPlanned ? [vehicleId, ts] : [vehicleId]),
  );
  return rows.map((r) => toReservation(r, ts));
}

/** Upcoming reservations across the fleet, for the dashboard. */
export async function upcomingReservations(env: Env, days = 21, limit = 20): Promise<Reservation[]> {
  const ts = now();
  const until = new Date(Date.now() + days * 86400_000).toISOString();
  const rows = await all<ReservationWithVehicleRow>(
    env.DB,
    `${WITH_VEHICLE} WHERE r.status = 'planned' AND r.ends_at >= ? AND r.starts_at <= ? ORDER BY r.starts_at LIMIT ?`,
    ts,
    until,
    limit,
  );
  return rows.map((r) => withVehicle(r, ts));
}

export async function createReservation(env: Env, user: SessionUser, input: ReservationCreateInput, ip: string, lang: Language): Promise<Reservation> {
  return withVehicleLock(env, input.vehicle_id, async () => {
    const v = await one<{ status: VehicleStatus }>(env.DB, "SELECT status FROM vehicles WHERE id = ?", input.vehicle_id);
    if (!v) throw badRequest("invalid_reference", { vehicle_id: "not_found" });
    if (v.status === "checked_out" || v.status === "archived") throw conflict("vehicle_status", { status: v.status });
    if (new Date(input.ends_at).getTime() <= Date.now()) throw badRequest("reservation_past", { ends_at: "past" });
    if (input.company_id) {
      const company = await one<{ company_type: string }>(env.DB, "SELECT company_type FROM companies WHERE id = ?", input.company_id);
      if (!company) throw badRequest("invalid_reference", { company_id: "not_found" });
      if (company.company_type === "supplier") throw badRequest("company_type", { company_id: "type" });
    }
    if (input.driver_id && !(await one(env.DB, "SELECT 1 AS x FROM drivers WHERE id = ?", input.driver_id))) {
      throw badRequest("invalid_reference", { driver_id: "not_found" });
    }
    const clash = await overlapping(env, input.vehicle_id, input.starts_at, input.ends_at);
    if (clash.length) {
      const w = formatWindow(clash[0], lang);
      throw conflict("reservation_overlap", { borrower: clash[0].borrower_name, from: w.from, to: w.to });
    }

    const id = uid();
    const ts = now();
    await env.DB.batch([
      stmt(
        env.DB,
        `INSERT INTO reservations (id, vehicle_id, company_id, driver_id, borrower_name, borrower_phone, borrower_email,
          starts_at, ends_at, notes, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'planned',?,?,?)`,
        id,
        input.vehicle_id,
        input.company_id ?? null,
        input.driver_id ?? null,
        input.borrower_name,
        input.borrower_phone,
        input.borrower_email,
        input.starts_at,
        input.ends_at,
        input.notes,
        user.id,
        ts,
        ts,
      ),
      auditStatement(env.DB, {
        actor_id: user.id,
        actor_label: user.name,
        action: "reservation.created",
        entity_type: "reservation",
        entity_id: id,
        vehicle_id: input.vehicle_id,
        details: { borrower: input.borrower_name, starts_at: input.starts_at, ends_at: input.ends_at },
        ip,
      }),
    ]);
    return toReservation(await getReservation(env, id), ts);
  });
}

export async function cancelReservation(env: Env, user: SessionUser, id: string, reason: string, ip: string): Promise<Reservation> {
  const r = await getReservation(env, id);
  if (r.status !== "planned") throw conflict("reservation_closed", { status: r.status });
  const ts = now();
  await env.DB.batch([
    stmt(
      env.DB,
      "UPDATE reservations SET status = 'cancelled', closed_by = ?, close_reason = ?, updated_at = ? WHERE id = ? AND status = 'planned'",
      user.id,
      reason,
      ts,
      id,
    ),
    auditStatement(env.DB, {
      actor_id: user.id,
      actor_label: user.name,
      action: "reservation.cancelled",
      entity_type: "reservation",
      entity_id: id,
      vehicle_id: r.vehicle_id,
      details: { borrower: r.borrower_name, reason },
      ip,
    }),
  ]);
  return toReservation(await getReservation(env, id), ts);
}

/** Marks the reservation a loan grew out of as fulfilled, inside the loan's batch. */
export function fulfilStatement(env: Env, reservationId: string, loanId: string, userId: string, ts: string): D1PreparedStatement {
  return stmt(
    env.DB,
    "UPDATE reservations SET status = 'fulfilled', loan_id = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'planned'",
    loanId,
    userId,
    ts,
    reservationId,
  );
}

/** Hourly: a planned window that has passed without a checkout is no longer a plan. */
export async function expireReservations(env: Env): Promise<number> {
  const ts = now();
  const res = await env.DB.prepare("UPDATE reservations SET status = 'expired', updated_at = ? WHERE status = 'planned' AND ends_at < ?")
    .bind(ts, ts)
    .run();
  return res.meta?.changes ?? 0;
}
