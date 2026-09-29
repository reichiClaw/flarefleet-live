import { Hono } from "hono";
import type { Protocol, ProtocolSnapshot } from "@shared/types";
import type { AppVariables, Env } from "../env";
import { requireAuth } from "../lib/auth";
import { all, json, one, paginate, parsePage } from "../lib/db";
import { notFound, ApiError } from "../lib/errors";
import { mediaForProtocol, toMediaItem, type MediaRow } from "../services/media";
import { generateProtocolPdf } from "../services/pdf";

export interface ProtocolRowFull {
  id: string;
  number: string;
  type: Protocol["type"];
  vehicle_id: string;
  loan_id: string | null;
  company_id: string | null;
  company_name: string | null;
  performed_by: string;
  performed_by_name: string;
  performed_at: string;
  odometer_km: number | null;
  operating_hours: number | null;
  condition: Protocol["condition"];
  notes: string;
  status_before: Protocol["status_before"];
  status_after: Protocol["status_after"];
  snapshot: string;
  language: "de" | "en";
  pdf_status: Protocol["pdf_status"];
  pdf_media_id: string | null;
  pdf_error: string | null;
  // optional joined vehicle fields for the documents list
  internal_number?: string;
  manufacturer?: string;
  model?: string;
  license_plate?: string;
  serial_number?: string;
  qr_code?: string;
  vehicle_status?: Protocol["status_after"];
  category_name?: string;
}

export function shapeProtocol(r: ProtocolRowFull, withSnapshot: boolean): Protocol {
  const snap = json<ProtocolSnapshot | undefined>(r.snapshot, undefined);
  const p: Protocol = {
    id: r.id,
    number: r.number,
    type: r.type,
    vehicle_id: r.vehicle_id,
    loan_id: r.loan_id,
    company_id: r.company_id,
    company_name: r.company_name,
    performed_by: r.performed_by,
    performed_by_name: r.performed_by_name,
    performed_at: r.performed_at,
    odometer_km: r.odometer_km,
    operating_hours: r.operating_hours,
    condition: r.condition,
    notes: r.notes,
    status_before: r.status_before,
    status_after: r.status_after,
    language: r.language,
    pdf_status: r.pdf_status,
    pdf_media_id: r.pdf_media_id,
    pdf_error: r.pdf_error,
  };
  if (withSnapshot) p.snapshot = snap;
  if (snap) {
    p.vehicle = {
      id: snap.vehicle.id,
      internal_number: snap.vehicle.internal_number,
      qr_code: snap.vehicle.qr_code,
      manufacturer: snap.vehicle.manufacturer,
      model: snap.vehicle.model,
      license_plate: snap.vehicle.license_plate,
      serial_number: snap.vehicle.serial_number,
      status: snap.vehicle.status,
      category_name: snap.vehicle.category_name,
    };
  }
  return p;
}

const PROTOCOL_SELECT =
  "SELECT p.*, u.name AS performed_by_name, co.name AS company_name FROM protocols p JOIN users u ON u.id = p.performed_by LEFT JOIN companies co ON co.id = p.company_id";

const PROTOCOL_TYPES = new Set([
  "check_in",
  "loan_checkout",
  "loan_return",
  "check_out",
  "maintenance_start",
  "maintenance_end",
  "damage_resolved",
  "status_correction",
]);
const PDF_STATUSES = new Set(["pending", "generated", "failed", "none"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const protocols = new Hono<{ Bindings: Env; Variables: AppVariables }>();
protocols.use("*", requireAuth("user"));

protocols.get("/", async (c) => {
  const url = new URL(c.req.url);
  const page = parsePage(url);
  const where: string[] = [];
  const params: unknown[] = [];
  const type = url.searchParams.get("type");
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("pdf_status");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (type && PROTOCOL_TYPES.has(type)) {
    where.push("p.type = ?");
    params.push(type);
  }
  const vehicleId = url.searchParams.get("vehicle_id");
  if (vehicleId) {
    where.push("p.vehicle_id = ?");
    params.push(vehicleId);
  }
  if (status && PDF_STATUSES.has(status)) {
    where.push("p.pdf_status = ?");
    params.push(status);
  }
  if (from && DATE_RE.test(from)) {
    where.push("p.performed_at >= ?");
    params.push(from.slice(0, 10));
  }
  if (to && DATE_RE.test(to)) {
    where.push("p.performed_at <= ?");
    params.push(`${to.slice(0, 10)}T23:59:59.999Z`);
  }
  if (q) {
    where.push("(p.number LIKE ? OR p.snapshot LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const sql = `${PROTOCOL_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""}`;
  const res = await paginate<ProtocolRowFull>(c.env.DB, sql, params, "p.performed_at DESC", page);
  return c.json({ ...res, results: res.results.map((r) => shapeProtocol(r, false)) });
});

protocols.get("/:id", async (c) => {
  const r = await one<ProtocolRowFull>(c.env.DB, `${PROTOCOL_SELECT} WHERE p.id = ?`, c.req.param("id"));
  if (!r) throw notFound();
  const media = await mediaForProtocol(c.env, r.id);
  const p = shapeProtocol(r, true);
  p.photos = media.filter((m) => m.kind === "photo").map(toMediaItem);
  p.signature = media.filter((m) => m.kind === "signature").map(toMediaItem)[0] ?? null;
  const damages = await all<Record<string, unknown>>(c.env.DB, "SELECT * FROM damages WHERE protocol_id = ? ORDER BY created_at", r.id);
  return c.json({ ...p, damages });
});

protocols.get("/:id/pdf", async (c) => {
  const r = await one<ProtocolRowFull>(c.env.DB, "SELECT * FROM protocols WHERE id = ?", c.req.param("id"));
  if (!r) throw notFound();
  if (!r.pdf_media_id) {
    const ok = await generateProtocolPdf(c.env, r.id);
    if (!ok) throw new ApiError(409, "pdf_not_ready");
  }
  const again = await one<{ pdf_media_id: string | null }>(c.env.DB, "SELECT pdf_media_id FROM protocols WHERE id = ?", r.id);
  const media = again?.pdf_media_id ? await one<MediaRow>(c.env.DB, "SELECT * FROM media WHERE id = ?", again.pdf_media_id) : null;
  if (!media) throw new ApiError(409, "pdf_not_ready");
  const obj = await c.env.MEDIA.get(media.r2_key);
  if (!obj) throw new ApiError(409, "pdf_not_ready");
  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${disposition}; filename="${r.number}.pdf"`,
      "cache-control": "private, max-age=86400",
    },
  });
});

protocols.post("/:id/regenerate-pdf", requireAuth("admin"), async (c) => {
  const id = c.req.param("id");
  const r = await one<{ id: string }>(c.env.DB, "SELECT id FROM protocols WHERE id = ?", id);
  if (!r) throw notFound();
  await c.env.DB.prepare("UPDATE protocols SET pdf_status = 'pending', pdf_media_id = NULL, pdf_error = NULL WHERE id = ?").bind(id).run();
  const ok = await generateProtocolPdf(c.env, id);
  return c.json({ ok });
});

export default protocols;
