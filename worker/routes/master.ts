import { Hono } from "hono";
import { CategorySchema, CompanySchema, DriverSchema } from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { badRequest, conflict, notFound } from "../lib/errors";
import { requireAuth } from "../lib/auth";
import { all, now, one, stmt, uid } from "../lib/db";
import { audit } from "../lib/audit";

const COMPANY_TYPES = new Set(["supplier", "subcontractor", "internal"]);

const master = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const shapeCategory = (r: Record<string, unknown>) => ({ ...r, is_active: r.is_active === 1 || r.is_active === true });
const shapeCompany = (r: Record<string, unknown>) => ({ ...r, is_active: r.is_active === 1 || r.is_active === true });

// ---- categories -----------------------------------------------------------
master.get("/categories", requireAuth("user"), async (c) => {
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    "SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.category_id = c.id AND v.status <> 'archived') AS vehicle_count FROM categories c ORDER BY c.is_active DESC, c.name",
  );
  return c.json({ results: rows.map(shapeCategory) });
});

master.post("/categories", requireAuth("admin"), async (c) => {
  const input = await parseBody(c, CategorySchema);
  if (await one(c.env.DB, "SELECT 1 AS x FROM categories WHERE name = ? COLLATE NOCASE", input.name)) throw conflict("duplicate_name");
  const id = uid();
  const ts = now();
  await stmt(c.env.DB, "INSERT INTO categories (id, name, meter_mode, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?)", id, input.name, input.meter_mode, input.is_active ? 1 : 0, ts, ts).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "category.created", entity_type: "category", entity_id: id, details: input, ip: c.get("ip") });
  return c.json(shapeCategory({ id, ...input, vehicle_count: 0 }), 201);
});

master.patch("/categories/:id", requireAuth("admin"), async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c, CategorySchema.partial());
  const existing = await one<Record<string, unknown>>(c.env.DB, "SELECT * FROM categories WHERE id = ?", id);
  if (!existing) throw notFound();
  if (input.name && (await one(c.env.DB, "SELECT 1 AS x FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?", input.name, id))) throw conflict("duplicate_name");
  await stmt(
    c.env.DB,
    "UPDATE categories SET name = COALESCE(?, name), meter_mode = COALESCE(?, meter_mode), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?",
    input.name ?? null,
    input.meter_mode ?? null,
    input.is_active === undefined ? null : input.is_active ? 1 : 0,
    now(),
    id,
  ).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "category.updated", entity_type: "category", entity_id: id, details: { changes: input }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, "SELECT * FROM categories WHERE id = ?", id);
  return c.json(shapeCategory(row!));
});

master.delete("/categories/:id", requireAuth("admin"), async (c) => {
  const id = c.req.param("id");
  const used = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM vehicles WHERE category_id = ?", id);
  if ((used?.c ?? 0) > 0) throw conflict("category_in_use");
  await stmt(c.env.DB, "DELETE FROM categories WHERE id = ?", id).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "category.deleted", entity_type: "category", entity_id: id, ip: c.get("ip") });
  return c.json({ ok: true });
});

// ---- companies ------------------------------------------------------------
master.get("/companies", requireAuth("user"), async (c) => {
  const requestedType = c.req.query("type");
  const type = requestedType && COMPANY_TYPES.has(requestedType) ? requestedType : undefined;
  const includeInactive = c.req.query("include_inactive") === "1";
  const where: string[] = [];
  const params: unknown[] = [];
  if (type) {
    where.push("company_type = ?");
    params.push(type);
  }
  if (!includeInactive) where.push("is_active = 1");
  const rows = await all<Record<string, unknown>>(c.env.DB, `SELECT * FROM companies${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY is_active DESC, name`, ...params);
  return c.json({ results: rows.map(shapeCompany) });
});

master.post("/companies", requireAuth("user"), async (c) => {
  const input = await parseBody(c, CompanySchema);
  const id = uid();
  const ts = now();
  await stmt(
    c.env.DB,
    "INSERT INTO companies (id, name, company_type, contact_name, phone, email, notes, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id,
    input.name,
    input.company_type,
    input.contact_name,
    input.phone,
    input.email,
    input.notes,
    input.is_active ? 1 : 0,
    ts,
    ts,
  ).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "company.created", entity_type: "company", entity_id: id, details: { name: input.name, type: input.company_type }, ip: c.get("ip") });
  return c.json(shapeCompany({ id, ...input }), 201);
});

master.patch("/companies/:id", requireAuth("admin"), async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c, CompanySchema.partial());
  const existing = await one<Record<string, unknown>>(c.env.DB, "SELECT * FROM companies WHERE id = ?", id);
  if (!existing) throw notFound();
  await stmt(
    c.env.DB,
    "UPDATE companies SET name = COALESCE(?, name), company_type = COALESCE(?, company_type), contact_name = COALESCE(?, contact_name), phone = COALESCE(?, phone), email = COALESCE(?, email), notes = COALESCE(?, notes), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?",
    input.name ?? null,
    input.company_type ?? null,
    input.contact_name ?? null,
    input.phone ?? null,
    input.email ?? null,
    input.notes ?? null,
    input.is_active === undefined ? null : input.is_active ? 1 : 0,
    now(),
    id,
  ).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "company.updated", entity_type: "company", entity_id: id, details: { changes: input }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, "SELECT * FROM companies WHERE id = ?", id);
  return c.json(shapeCompany(row!));
});

// ---- drivers --------------------------------------------------------------
master.get("/drivers", requireAuth("user"), async (c) => {
  const companyId = c.req.query("company_id");
  const includeInactive = c.req.query("include_inactive") === "1";
  const where: string[] = [];
  const params: unknown[] = [];
  if (companyId) {
    where.push("d.company_id = ?");
    params.push(companyId);
  }
  if (!includeInactive) where.push("d.is_active = 1");
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT d.*, co.name AS company_name FROM drivers d LEFT JOIN companies co ON co.id = d.company_id${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY d.is_active DESC, d.name`,
    ...params,
  );
  return c.json({ results: rows.map(shapeCompany) });
});

/** Fails with a readable 400 instead of an opaque FOREIGN KEY error from D1. */
async function assertCompany(c: { env: Env }, companyId: string | null | undefined) {
  if (!companyId) return;
  if (!(await one(c.env.DB, "SELECT 1 AS x FROM companies WHERE id = ?", companyId))) {
    throw badRequest("invalid_reference", { company_id: "not_found" });
  }
}

master.post("/drivers", requireAuth("user"), async (c) => {
  const input = await parseBody(c, DriverSchema);
  await assertCompany(c, input.company_id);
  const id = uid();
  const ts = now();
  await stmt(c.env.DB, "INSERT INTO drivers (id, company_id, name, phone, email, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", id, input.company_id ?? null, input.name, input.phone, input.email, input.is_active ? 1 : 0, ts, ts).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "driver.created", entity_type: "driver", entity_id: id, details: { name: input.name }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, "SELECT d.*, co.name AS company_name FROM drivers d LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = ?", id);
  return c.json(shapeCompany(row!), 201);
});

master.patch("/drivers/:id", requireAuth("admin"), async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c, DriverSchema.partial());
  const existing = await one(c.env.DB, "SELECT id FROM drivers WHERE id = ?", id);
  if (!existing) throw notFound();
  if (input.company_id !== undefined) await assertCompany(c, input.company_id);
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now()];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(k === "is_active" ? (v ? 1 : 0) : v);
  }
  await stmt(c.env.DB, `UPDATE drivers SET ${sets.join(", ")} WHERE id = ?`, ...params, id).run();
  const actor = c.get("user");
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "driver.updated", entity_type: "driver", entity_id: id, details: { changes: input }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, "SELECT d.*, co.name AS company_name FROM drivers d LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = ?", id);
  return c.json(shapeCompany(row!));
});

export default master;
