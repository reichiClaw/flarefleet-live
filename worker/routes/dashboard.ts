import { Hono } from "hono";
import type { AuditEntry, DashboardSummary, Loan, VehicleStatus } from "@shared/types";
import type { AppVariables, Env } from "../env";
import { requireAuth } from "../lib/auth";
import { all, json, now, paginate, parsePage } from "../lib/db";
import { hasRole } from "@shared/types";
import { VEHICLE_SELECT, toLoan, toSummary, type LoanRow, type VehicleRow } from "../services/vehicles";

const LOAN_STATUSES = new Set(["active", "returned", "cancelled", "all"]);

const dashboard = new Hono<{ Bindings: Env; Variables: AppVariables }>();
dashboard.use("*", requireAuth("user"));

type LoanWithVehicleRow = LoanRow & {
  internal_number: string;
  manufacturer: string;
  model: string;
  license_plate: string;
  serial_number: string;
  qr_code: string;
  category_name: string;
  vehicle_status: VehicleStatus;
};

const LOAN_WITH_VEHICLE = `
  SELECT l.*, co.name AS company_name, v.internal_number, v.manufacturer, v.model, v.license_plate, v.serial_number, v.qr_code,
         v.status AS vehicle_status, c.name AS category_name
  FROM loans l
  LEFT JOIN companies co ON co.id = l.company_id
  JOIN vehicles v ON v.id = l.vehicle_id
  JOIN categories c ON c.id = v.category_id`;

function withVehicle(r: LoanWithVehicleRow): Loan {
  const { internal_number, manufacturer, model, license_plate, serial_number, qr_code, category_name, vehicle_status, ...loan } = r;
  return {
    ...toLoan(loan as LoanRow),
    vehicle: { id: loan.vehicle_id, internal_number, manufacturer, model, license_plate, serial_number, qr_code, category_name, status: vehicle_status },
  };
}

dashboard.get("/summary", async (c) => {
  const db = c.env.DB;
  const ts = now();
  const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  // The activity feed mirrors the audit log, which is admin-only; regular users
  // would otherwise read settings and user changes here.
  const showRecent = hasRole(c.get("user").role, "admin");
  const countRows = await all<{ status: VehicleStatus; c: number }>(db, "SELECT status, COUNT(*) AS c FROM vehicles GROUP BY status");
  const counts = { announced: 0, available: 0, loaned: 0, damaged: 0, maintenance: 0, checked_out: 0, archived: 0 } as Record<VehicleStatus, number>;
  for (const r of countRows) counts[r.status] = r.c;

  const [overdueLoans, dueSoon, arrivals, attention, returnDue, recentAudit, openDamages, failedPdfs] = await Promise.all([
    all<LoanWithVehicleRow>(db, `${LOAN_WITH_VEHICLE} WHERE l.status = 'active' AND l.expected_return_at < ? ORDER BY l.expected_return_at LIMIT 20`, ts),
    all<LoanWithVehicleRow>(db, `${LOAN_WITH_VEHICLE} WHERE l.status = 'active' AND l.expected_return_at >= ? AND l.expected_return_at <= ? ORDER BY l.expected_return_at LIMIT 20`, ts, soon),
    all<VehicleRow>(db, `${VEHICLE_SELECT} WHERE v.status = 'announced' ORDER BY v.expected_arrival IS NULL, v.expected_arrival, v.created_at LIMIT 20`),
    all<VehicleRow>(db, `${VEHICLE_SELECT} WHERE v.status IN ('damaged','maintenance') ORDER BY v.updated_at DESC LIMIT 20`),
    all<VehicleRow>(db, `${VEHICLE_SELECT} WHERE v.return_due IS NOT NULL AND v.return_due <= ? AND v.status NOT IN ('checked_out','archived') ORDER BY v.return_due LIMIT 20`, weekAhead),
    showRecent
      ? all<Record<string, unknown>>(
          db,
          "SELECT id, actor_id, actor_label, action, entity_type, entity_id, vehicle_id, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT 15",
        )
      : Promise.resolve([]),
    db.prepare("SELECT COUNT(*) AS c FROM damages WHERE resolved_at IS NULL").first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) AS c FROM protocols WHERE pdf_status = 'failed'").first<{ c: number }>(),
  ]);

  const summary: DashboardSummary = {
    counts,
    fleet: counts.announced + counts.available + counts.loaned + counts.damaged + counts.maintenance,
    active_loans: counts.loaned,
    overdue_loans: overdueLoans.length,
    open_damages: openDamages?.c ?? 0,
    failed_pdfs: failedPdfs?.c ?? 0,
    arrivals: arrivals.map((v) => ({ ...toSummary(v), expected_arrival: v.expected_arrival })),
    overdue: overdueLoans.map(withVehicle),
    due_soon: dueSoon.map(withVehicle),
    attention: attention.map((v) => ({ ...toSummary(v), open_damage_count: Number(v.open_damage_count) })),
    return_due: returnDue.map((v) => ({ ...toSummary(v), return_due: v.return_due })),
    recent: recentAudit.map((a) => ({ ...(a as unknown as AuditEntry), details: json(a.details, null) })),
  };
  return c.json(summary);
});

/** Loan list (active / history) with vehicle summary. */
dashboard.get("/loans", async (c) => {
  const url = new URL(c.req.url);
  const page = parsePage(url);
  const requested = url.searchParams.get("status") ?? "active";
  const status = LOAN_STATUSES.has(requested) ? requested : "active";
  const where = status === "all" ? "" : " WHERE l.status = ?";
  const params = status === "all" ? [] : [status];
  const res = await paginate<LoanWithVehicleRow>(
    c.env.DB,
    `${LOAN_WITH_VEHICLE}${where}`,
    params,
    status === "active" ? "l.expected_return_at" : "l.checked_out_at DESC",
    page,
  );
  return c.json({ ...res, results: res.results.map(withVehicle) });
});

export default dashboard;
