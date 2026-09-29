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
import { baseUrlFor, loadSettings } from "../lib/settings";
import { emailAvailable, sendEmail } from "../lib/email";
import { t } from "../lib/i18n";

const users = new Hono<{ Bindings: Env; Variables: AppVariables }>();
users.use("*", requireAuth("admin"));

const COLS = "id, email, name, role, language, must_change_password, is_active, last_login_at, created_at";

function shape(r: Record<string, unknown>) {
  return { ...r, must_change_password: r.must_change_password === 1, is_active: r.is_active === 1 };
}

users.get("/", async (c) => {
  const rows = await all<Record<string, unknown>>(c.env.DB, `SELECT ${COLS} FROM users WHERE deleted_at IS NULL ORDER BY is_active DESC, name`);
  return c.json({ results: rows.map(shape) });
});

users.post("/", async (c) => {
  const actor = c.get("user");
  const input = await parseBody(c, UserCreateSchema);
  if (input.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  if (await one(c.env.DB, "SELECT 1 AS x FROM users WHERE email = ? AND deleted_at IS NULL", input.email)) throw conflict("email_taken");
  const id = uid();
  const ts = now();
  const settings = await loadSettings(c.env);
  const canEmail = input.send_invite && emailAvailable(c.env, settings);
  await stmt(
    c.env.DB,
    "INSERT INTO users (id, email, name, role, password_hash, must_change_password, language, is_active, created_at, updated_at) VALUES (?,?,?,?,NULL,1,?,1,?,?)",
    id,
    input.email,
    input.name,
    input.role,
    input.language,
    ts,
    ts,
  ).run();
  let invited = false;
  if (canEmail) {
    const token = randomToken(24);
    await c.env.KV.put(`pwreset:${token}`, id, { expirationTtl: 48 * 3600 });
    const link = `${baseUrlFor(settings, c.req.url)}/reset-password?token=${token}&invite=1`;
    invited = await sendEmail(
      c.env,
      input.email,
      t(input.language, "email.invite.subject", { org: settings.org_name }),
      t(input.language, "email.invite.body", { name: input.name, org: settings.org_name, link, email: input.email }),
    );
  }
  // Without a delivered invitation the account would have no way in at all, so
  // fall back to a temporary password the admin can pass on.
  let tempPassword: string | null = null;
  if (!invited) {
    tempPassword = generatePassword();
    await stmt(c.env.DB, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", await hashPassword(tempPassword, pbkdf2Iterations(c.env)), now(), id).run();
  }
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "user.created", entity_type: "user", entity_id: id, details: { email: input.email, role: input.role, invited }, ip: c.get("ip") });
  const row = await one<Record<string, unknown>>(c.env.DB, `SELECT ${COLS} FROM users WHERE id = ?`, id);
  // The temporary password is shown once to the admin when no e-mail could be sent.
  return c.json({ ...shape(row!), temporary_password: tempPassword, invited }, 201);
});

users.patch("/:id", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c, UserUpdateSchema);
  const target = await one<{ id: string; role: "super_admin" | "admin" | "user"; is_active: number; name: string }>(c.env.DB, "SELECT id, role, is_active, name FROM users WHERE id = ? AND deleted_at IS NULL", id);
  if (!target) throw notFound();
  if (hasRole(target.role, "super_admin") && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  if (input.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  const demoting = target.role === "super_admin" && ((input.role && input.role !== "super_admin") || input.is_active === false);
  if (demoting) {
    const others = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1 AND deleted_at IS NULL AND id <> ?", id);
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
  const target = await one<{ id: string; role: "super_admin" | "admin" | "user"; email: string; name: string; language: "de" | "en" }>(c.env.DB, "SELECT id, role, email, name, language FROM users WHERE id = ? AND deleted_at IS NULL", id);
  if (!target) throw notFound();
  if (target.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  const settings = await loadSettings(c.env);
  const canEmail = emailAvailable(c.env, settings);
  let tempPassword: string | null = null;
  let emailed = false;
  if (canEmail) {
    const token = randomToken(24);
    await c.env.KV.put(`pwreset:${token}`, id, { expirationTtl: 48 * 3600 });
    const link = `${baseUrlFor(settings, c.req.url)}/reset-password?token=${token}`;
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

/**
 * Deletes a user. Accounts that never signed off a workflow step are removed
 * completely; accounts referenced by protocols, loans, damages or imports keep
 * their row so that history stays intact, but are marked deleted: they vanish
 * from the app, existing sessions stop working on the next request (loadUser
 * ignores them) and their e-mail address becomes available again.
 */
users.delete("/:id", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  const target = await one<{ id: string; role: "super_admin" | "admin" | "user"; email: string; name: string }>(
    c.env.DB,
    "SELECT id, role, email, name FROM users WHERE id = ? AND deleted_at IS NULL",
    id,
  );
  if (!target) throw notFound();
  if (target.id === actor.id) throw conflict("cannot_delete_self");
  if (target.role === "super_admin" && actor.role !== "super_admin") throw new ApiError(403, "role_not_allowed");
  if (target.role === "super_admin") {
    const others = await one<{ c: number }>(
      c.env.DB,
      "SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin' AND is_active = 1 AND deleted_at IS NULL AND id <> ?",
      id,
    );
    if ((others?.c ?? 0) === 0) throw conflict("last_super_admin");
  }

  // Every table that names the user. The audit log is left out on purpose: it
  // stores the actor's name as text, so it stays readable without the account.
  const refs = await one<{ protocols: number; loans: number; damages: number; imports: number; vehicles: number; media: number }>(
    c.env.DB,
    `SELECT (SELECT COUNT(*) FROM protocols WHERE performed_by = ?) AS protocols,
            (SELECT COUNT(*) FROM loans WHERE created_by = ? OR returned_by = ?) AS loans,
            (SELECT COUNT(*) FROM damages WHERE reported_by = ? OR resolved_by = ?) AS damages,
            (SELECT COUNT(*) FROM import_jobs WHERE created_by = ?) AS imports,
            (SELECT COUNT(*) FROM vehicles WHERE created_by = ?) AS vehicles,
            (SELECT COUNT(*) FROM media WHERE uploaded_by = ? AND attached_at IS NOT NULL) AS media`,
    id,
    id,
    id,
    id,
    id,
    id,
    id,
    id,
  );
  const history =
    (refs?.protocols ?? 0) + (refs?.loans ?? 0) + (refs?.damages ?? 0) + (refs?.imports ?? 0) + (refs?.vehicles ?? 0) + (refs?.media ?? 0);
  const ts = now();
  if (history === 0) {
    await stmt(c.env.DB, "DELETE FROM users WHERE id = ?", id).run();
  } else {
    await stmt(
      c.env.DB,
      `UPDATE users SET deleted_at = ?, is_active = 0, password_hash = NULL, must_change_password = 0,
         failed_logins = 0, locked_until = NULL, email = ?, updated_at = ? WHERE id = ?`,
      ts,
      `deleted-${id}@deleted.invalid`,
      ts,
      id,
    ).run();
  }
  await audit(c.env.DB, {
    actor_id: actor.id,
    actor_label: actor.name,
    action: "user.deleted",
    entity_type: "user",
    entity_id: id,
    details: { email: target.email, name: target.name, role: target.role, mode: history === 0 ? "removed" : "anonymized", history },
    ip: c.get("ip"),
  });
  return c.json({ ok: true, mode: history === 0 ? "removed" : "anonymized", history });
});

export default users;
