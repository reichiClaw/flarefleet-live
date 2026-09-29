import { Hono } from "hono";
import type { AuditEntry, Damage, Protocol } from "@shared/types";
import { hasRole } from "@shared/types";
import {
  ArchiveSchema,
  CheckInSchema,
  CheckOutSchema,
  CorrectionSchema,
  DamageReportSchema,
  DamageResolveSchema,
  LoanCheckoutSchema,
  LoanReturnSchema,
  MaintenanceEndSchema,
  MaintenanceStartSchema,
  ReturnDueSchema,
  VehicleCreateSchema,
  VehicleUpdateSchema,
} from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { requireAuth, type AppContext } from "../lib/auth";
import { forbidden } from "../lib/errors";
import { all, json, now, stmt } from "../lib/db";
import { baseUrlFor, loadSettings } from "../lib/settings";
import { qrSvg } from "../lib/qr";
import { audit } from "../lib/audit";
import { createVehicle, getVehicle, getVehicleRow, listLoansForVehicle, listVehicles, updateVehicle } from "../services/vehicles";
import * as wf from "../services/workflows";
import { toMediaItem, type MediaRow } from "../services/media";
import { shapeProtocol, type ProtocolRowFull } from "./protocols";

const vehicles = new Hono<{ Bindings: Env; Variables: AppVariables }>();
vehicles.use("*", requireAuth("user"));

async function ctx(c: AppContext): Promise<wf.WorkflowCtx> {
  return {
    env: c.env,
    user: c.get("user"),
    ip: c.get("ip"),
    lang: c.get("lang"),
    settings: await loadSettings(c.env),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
}

vehicles.get("/", async (c) => c.json(await listVehicles(c.env, new URL(c.req.url))));

vehicles.post("/", requireAuth("admin"), async (c) => {
  const input = await parseBody(c, VehicleCreateSchema);
  return c.json(await createVehicle(c.env, c.get("user"), input, c.get("ip")), 201);
});

vehicles.get("/:id", async (c) => c.json(await getVehicle(c.env, c.req.param("id"), c.get("user").role)));

vehicles.patch("/:id", requireAuth("admin"), async (c) => {
  const input = await parseBody(c, VehicleUpdateSchema);
  return c.json(await updateVehicle(c.env, c.get("user"), c.req.param("id"), input, c.get("ip")));
});

vehicles.get("/:id/loans", async (c) => {
  const id = c.req.param("id");
  await getVehicleRow(c.env, id);
  return c.json({ results: await listLoansForVehicle(c.env, id) });
});

vehicles.get("/:id/protocols", async (c) => {
  const rows = await all<ProtocolRowFull>(
    c.env.DB,
    "SELECT p.*, u.name AS performed_by_name, co.name AS company_name FROM protocols p JOIN users u ON u.id = p.performed_by LEFT JOIN companies co ON co.id = p.company_id WHERE p.vehicle_id = ? ORDER BY p.performed_at DESC",
    c.req.param("id"),
  );
  return c.json({ results: rows.map((r) => shapeProtocol(r, false)) });
});

vehicles.get("/:id/damages", async (c) => {
  const id = c.req.param("id");
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    "SELECT d.*, u.name AS reported_by_name FROM damages d LEFT JOIN users u ON u.id = d.reported_by WHERE d.vehicle_id = ? ORDER BY d.resolved_at IS NOT NULL, d.reported_at DESC",
    id,
  );
  // One query for all damage photos: a vehicle with many damages would otherwise
  // run past the per-invocation D1 query limit.
  const photos = await all<MediaRow>(
    c.env.DB,
    "SELECT * FROM media WHERE vehicle_id = ? AND damage_id IS NOT NULL AND discarded_at IS NULL ORDER BY created_at",
    id,
  );
  const byDamage = new Map<string, MediaRow[]>();
  for (const m of photos) {
    if (!m.damage_id) continue;
    const list = byDamage.get(m.damage_id) ?? [];
    list.push(m);
    byDamage.set(m.damage_id, list);
  }
  const results: Damage[] = rows.map((r) => ({
    ...(r as unknown as Damage),
    photos: (byDamage.get(r.id as string) ?? []).map(toMediaItem),
  }));
  return c.json({ results });
});

/** Merged chronological history: protocols, damages, loans, audit entries. */
vehicles.get("/:id/timeline", async (c) => {
  const id = c.req.param("id");
  await getVehicleRow(c.env, id);
  const protocols = await all<ProtocolRowFull>(
    c.env.DB,
    "SELECT p.*, u.name AS performed_by_name, co.name AS company_name FROM protocols p JOIN users u ON u.id = p.performed_by LEFT JOIN companies co ON co.id = p.company_id WHERE p.vehicle_id = ? ORDER BY p.performed_at DESC LIMIT 200",
    id,
  );
  const auditRows = await all<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM audit_log WHERE vehicle_id = ? AND entity_type <> 'protocol' ORDER BY created_at DESC LIMIT 200",
    id,
  );
  const photos = await all<MediaRow>(c.env.DB, "SELECT * FROM media WHERE vehicle_id = ? AND kind = 'photo' AND discarded_at IS NULL ORDER BY created_at DESC", id);
  const items = [
    ...protocols.map((p) => ({ kind: "protocol" as const, at: p.performed_at, protocol: shapeProtocol(p, false) })),
    ...auditRows.map((a) => ({
      kind: "audit" as const,
      at: a.created_at as string,
      audit: { ...(a as unknown as AuditEntry), details: json(a.details, null) } as AuditEntry,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  return c.json({ items, photos: photos.map(toMediaItem) });
});

vehicles.get("/:id/qr.svg", async (c) => {
  const v = await getVehicleRow(c.env, c.req.param("id"));
  const settings = await loadSettings(c.env);
  const svg = qrSvg(`${baseUrlFor(settings, c.req.url)}/q/${v.qr_code}`);
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" } });
});

// ---- workflows ------------------------------------------------------------
vehicles.post("/:id/check-in", async (c) => c.json(await wf.checkIn(await ctx(c), c.req.param("id"), await parseBody(c, CheckInSchema)), 201));
vehicles.post("/:id/loan", async (c) => c.json(await wf.loanCheckout(await ctx(c), c.req.param("id"), await parseBody(c, LoanCheckoutSchema)), 201));
vehicles.post("/:id/return", async (c) => c.json(await wf.loanReturn(await ctx(c), c.req.param("id"), await parseBody(c, LoanReturnSchema)), 201));
vehicles.post("/:id/check-out", async (c) => {
  const input = await parseBody(c, CheckOutSchema);
  // Archiving retires a vehicle from the fleet, so it stays an admin action even
  // when it happens as part of a check-out.
  if (input.archive && !hasRole(c.get("user").role, "admin")) throw forbidden();
  return c.json(await wf.checkOut(await ctx(c), c.req.param("id"), input), 201);
});
vehicles.post("/:id/maintenance/start", async (c) => c.json(await wf.maintenanceStart(await ctx(c), c.req.param("id"), await parseBody(c, MaintenanceStartSchema)), 201));
vehicles.post("/:id/maintenance/end", async (c) => c.json(await wf.maintenanceEnd(await ctx(c), c.req.param("id"), await parseBody(c, MaintenanceEndSchema)), 201));
vehicles.post("/:id/damages", async (c) => c.json(await wf.reportDamage(await ctx(c), c.req.param("id"), await parseBody(c, DamageReportSchema)), 201));
vehicles.post("/:id/damages/:damageId/resolve", async (c) =>
  c.json(await wf.resolveDamage(await ctx(c), c.req.param("id"), c.req.param("damageId"), await parseBody(c, DamageResolveSchema)), 201),
);

// ---- admin ----------------------------------------------------------------
vehicles.post("/:id/correct-status", requireAuth("admin"), async (c) =>
  c.json(await wf.correctStatus(await ctx(c), c.req.param("id"), await parseBody(c, CorrectionSchema)), 201),
);
vehicles.post("/:id/archive", requireAuth("admin"), async (c) => c.json(await wf.archiveVehicle(await ctx(c), c.req.param("id"), (await parseBody(c, ArchiveSchema)).reason)));
vehicles.post("/:id/unarchive", requireAuth("admin"), async (c) => c.json(await wf.archiveVehicle(await ctx(c), c.req.param("id"), "", true)));
vehicles.post("/:id/return-due", async (c) => {
  const input = await parseBody(c, ReturnDueSchema);
  const id = c.req.param("id");
  await getVehicleRow(c.env, id);
  await stmt(c.env.DB, "UPDATE vehicles SET return_due = ?, updated_at = ? WHERE id = ?", input.return_due || null, now(), id).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "vehicle.return_due_set", entity_type: "vehicle", entity_id: id, vehicle_id: id, details: { return_due: input.return_due }, ip: c.get("ip") });
  return c.json(await getVehicle(c.env, id, actor.role));
});

export default vehicles;
export type { Protocol };
