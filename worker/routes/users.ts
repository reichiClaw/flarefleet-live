import { Hono } from "hono";
import { hasRole } from "@shared/types";
import { UserCreateSchema, UserUpdateSchema } from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { ApiError, conflict, notFound } from "../lib/errors";
import { generatePassword, hashPassword, pbkdf2Iterations, randomToken } from "../lib/crypto";
import { requireAuth } from "../lib/auth";
import { all, now, one, stmt, uid } from "../lib/db";
import { audit } from "../lib/audit";
import { loadSettings } from "../lib/settings";
import { emailAvailable, sendEmail } from "../lib/email";
import { t } from "../lib/i18n";

const users = new Hono<{ Bindings: Env; Variables: AppVariables }>();
users.use("*", requireAuth("admin"));

const COLS = "id, email, name, role, language, must_change_password, is_active, last_login_at, created_at";

function shape(r: Record<string, unknown>) {
  return { ...r, must_change_password: r.must_change_password === 1, is_active: r.is_active === 1 };
}

users.get("/", async (c) => {
  const rows = await all<Record<string, unknown>>(c.env.DB, `SELECT ${COLS} FROM users ORDER BY is_active DESC, name`);
  return c.json({ results: rows.map(shape) });
});

users.post("/", async (c) => {
  const actor = c.get("user");
  const input = await parseBody(c, UserCreateSchema);
  if (input.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  if (await one(c.env.DB, "SELECT 1 AS x FROM users WHERE email = ?", input.email)) throw conflict("email_taken");
  const id = uid();
  const ts = now();
  const settings = await loadSettings(c.env);
  const canEmail = input.send_invite && emailAvailable(c.env, settings);
  const tempPassword = canEmail ? null : generatePassword();
  await stmt(
    c.env.DB,
    "INSERT INTO users (id, email, name, role, password_hash, must_change_password, language, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,1,?,?)",
    id,
    input.email,
    input.name,
    input.role,
    tempPassword ? await hashPassword(tempPassword, pbkdf2Iterations(c.env)) : null,
    input.language,
    ts,
    ts,
  ).run();
  let invited = false;
  if (canEmail) {
    const token = randomToken(24);
    await c.env.KV.put(`pwreset:${token}`, id, { expirationTtl: 48 * 3600 });
    const link = `${settings.public_base_url || c.env.PUBLIC_BASE_URL}/reset-password?token=${token}&invite=1`;
    invited = await sendEmail(
      c.env,
      input.email,
      t(input.language, "email.invite.subject", { org: settings.org_name }),
      t(input.language, "email.invite.body", { name: input.name, org: settings.org_name, link, email: input.email }),
    );
  }
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "user.created", entity_type: "user", entity_id: id, details: { email: input.email, role: input.role, invited }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, `SELECT ${COLS} FROM users WHERE id = ?`, id);
  // The temporary password is shown once to the admin when no e-mail could be sent.
  return c.json({ ...shape(row!), temporary_password: invited ? null : tempPassword, invited }, 201);
});

users.patch("/:id", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c, UserUpdateSchema);
  const target = await one<{ id: string; role: "super_admin" | "admin" | "user"; is_active: number; name: string }>(c.env.DB, "SELECT id, role, is_active, name FROM users WHERE id = ?", id);
  if (!target) throw notFound();
  if (hasRole(target.role, "super_admin") && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  if (input.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  const demoting = target.role === "super_admin" && ((input.role && input.role !== "super_admin") || input.is_active === false);
  if (demoting) {
    const others = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1 AND id <> ?", id);
    if ((others?.c ?? 0) === 0) throw conflict("last_super_admin");
  }
  await stmt(
    c.env.DB,
    "UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), language = COALESCE(?, language), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?",
    input.name ?? null,
    input.role ?? null,
    input.language ?? null,
    input.is_active === undefined ? null : input.is_active ? 1 : 0,
    now(),
    id,
  ).run();
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "user.updated", entity_type: "user", entity_id: id, details: { changes: input }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, `SELECT ${COLS} FROM users WHERE id = ?`, id);
  return c.json(shape(row!));
});

users.post("/:id/reset-password", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  const target = await one<{ id: string; role: "super_admin" | "admin" | "user"; email: string; name: string; language: "de" | "en" }>(c.env.DB, "SELECT id, role, email, name, language FROM users WHERE id = ?", id);
  if (!target) throw notFound();
  if (target.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  const settings = await loadSettings(c.env);
  const canEmail = emailAvailable(c.env, settings);
  let tempPassword: string | null = null;
  let emailed = false;
  if (canEmail) {
    const token = randomToken(24);
    await c.env.KV.put(`pwreset:${token}`, id, { expirationTtl: 48 * 3600 });
    const link = `${settings.public_base_url || c.env.PUBLIC_BASE_URL}/reset-password?token=${token}`;
    emailed = await sendEmail(c.env, target.email, t(target.language, "email.reset.subject", { org: settings.org_name }), t(target.language, "email.reset.body", { name: target.name, link }));
  }
  if (!emailed) {
    tempPassword = generatePassword();
    await stmt(c.env.DB, "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?", await hashPassword(tempPassword, pbkdf2Iterations(c.env)), now(), id).run();
  }
  // Invalidate all sessions of that user is not possible with KV listing cheaply; sessions expire in 14 days.
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "user.password_reset", entity_type: "user", entity_id: id, details: { emailed }, ip: c.get("ip") });
  return c.json({ ok: true, emailed, temporary_password: tempPassword });
});

export default users;
