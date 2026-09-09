import { Hono } from "hono";
import { z } from "zod";
import type { Me } from "@shared/types";
import { ChangePasswordSchema, ForgotPasswordSchema, LoginSchema, ProfileUpdateSchema, ResetPasswordSchema } from "@shared/schemas";
import type { AppVariables, Env, SessionUser } from "../env";
import { parseBody } from "../lib/validate";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { hashPassword, needsRehash, pbkdf2Iterations, randomToken, verifyPassword } from "../lib/crypto";
import { clearSessionCookie, createSession, destroySession, rateLimit, requireAuth, setSessionCookie } from "../lib/auth";
import { now, one, stmt, uid } from "../lib/db";
import { audit } from "../lib/audit";
import { isUsableBaseUrl, loadSettings, publicSettings } from "../lib/settings";
import { emailAvailable, sendEmail } from "../lib/email";
import { t } from "../lib/i18n";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "super_admin" | "admin" | "user";
  language: "de" | "en";
  password_hash: string | null;
  must_change_password: number;
  is_active: number;
  failed_logins: number;
  locked_until: string | null;
}

async function meResponse(env: Env, user: SessionUser, csrf: string): Promise<Me> {
  const settings = await loadSettings(env);
  return { ...user, csrf_token: csrf, settings: publicSettings(settings, env) };
}

auth.get("/status", async (c) => {
  const row = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users");
  const settings = await loadSettings(c.env);
  return c.json({ needs_setup: (row?.c ?? 0) === 0, org_name: settings.org_name, default_language: settings.default_language, email_enabled: emailAvailable(c.env, settings) });
});

const SetupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200),
  org_name: z.string().trim().min(1).max(120).optional(),
  language: z.enum(["de", "en"]).default("de"),
});

/** First-run: creates the initial super admin when the user table is empty. */
auth.post("/setup", async (c) => {
  const count = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users");
  if ((count?.c ?? 0) > 0) throw new ApiError(403, "forbidden");
  const input = await parseBody(c, SetupSchema);
  const id = uid();
  const ts = now();
  await c.env.DB.batch([
    stmt(
      c.env.DB,
      "INSERT INTO users (id, email, name, role, password_hash, must_change_password, language, is_active, created_at, updated_at) VALUES (?,?,?,'super_admin',?,0,?,1,?,?)",
      id,
      input.email,
      input.name,
      await hashPassword(input.password, pbkdf2Iterations(c.env)),
      input.language,
      ts,
      ts,
    ),
    ...(input.org_name
      ? [stmt(c.env.DB, "INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('org_name', ?, ?, ?)", JSON.stringify(input.org_name), id, ts)]
      : []),
    stmt(c.env.DB, "INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('default_language', ?, ?, ?)", JSON.stringify(input.language), id, ts),
    // Remember the URL the app was reached at so QR labels and e-mail links work
    // without editing PUBLIC_BASE_URL (Deploy-to-Cloudflare button flow).
    ...(isUsableBaseUrl(c.env.PUBLIC_BASE_URL)
      ? []
      : [stmt(c.env.DB, "INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('public_base_url', ?, ?, ?)", JSON.stringify(new URL(c.req.url).origin), id, ts)]),
  ]);
  await c.env.KV.delete("settings:v1");
  await audit(c.env.DB, { actor_id: id, actor_label: input.name, action: "system.setup", entity_type: "user", entity_id: id, ip: c.get("ip") });
  const session = await createSession(c.env, id, c.get("ip"));
  setSessionCookie(c, session.id);
  const user: SessionUser = { id, email: input.email, name: input.name, role: "super_admin", language: input.language, must_change_password: false };
  return c.json(await meResponse(c.env, user, session.csrf), 201);
});

auth.post("/login", async (c) => {
  const ip = c.get("ip");
  if (!(await rateLimit(c.env, `login:${ip}`, 20, 60))) throw new ApiError(429, "rate_limited");
  const input = await parseBody(c, LoginSchema);
  const u = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE email = ?", input.email);
  const ts = now();
  if (u && u.locked_until && u.locked_until > ts) throw new ApiError(423, "account_locked");
  const ok = u ? await verifyPassword(input.password, u.password_hash) : false;
  if (!u || !ok) {
    if (u) {
      const failed = u.failed_logins + 1;
      const lock = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await stmt(c.env.DB, "UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", lock ? 0 : failed, lock, u.id).run();
      await audit(c.env.DB, { actor_id: u.id, actor_label: u.email, action: "auth.login_failed", entity_type: "user", entity_id: u.id, ip, details: { locked: !!lock } });
    }
    throw new ApiError(401, "invalid_credentials");
  }
  if (!u.is_active) throw new ApiError(403, "account_inactive");
  const iterations = pbkdf2Iterations(c.env);
  if (u.password_hash && needsRehash(u.password_hash, iterations)) {
    await stmt(c.env.DB, "UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(input.password, iterations), u.id).run();
  }
  await stmt(c.env.DB, "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", ts, u.id).run();
  const session = await createSession(c.env, u.id, ip);
  setSessionCookie(c, session.id);
  await audit(c.env.DB, { actor_id: u.id, actor_label: u.name, action: "auth.login", entity_type: "user", entity_id: u.id, ip });
  const user: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role, language: u.language, must_change_password: u.must_change_password === 1 };
  return c.json(await meResponse(c.env, user, session.csrf));
});

auth.post("/logout", async (c) => {
  const sid = c.get("session_id");
  if (sid) await destroySession(c.env, sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth("user", { allowPasswordChange: true }), async (c) => {
  return c.json(await meResponse(c.env, c.get("user"), c.get("csrf")));
});

auth.patch("/me", requireAuth("user", { allowPasswordChange: true }), async (c) => {
  const input = await parseBody(c, ProfileUpdateSchema);
  const user = c.get("user");
  await stmt(
    c.env.DB,
    "UPDATE users SET name = COALESCE(?, name), language = COALESCE(?, language), updated_at = ? WHERE id = ?",
    input.name ?? null,
    input.language ?? null,
    now(),
    user.id,
  ).run();
  const updated: SessionUser = { ...user, name: input.name ?? user.name, language: input.language ?? user.language };
  return c.json(await meResponse(c.env, updated, c.get("csrf")));
});

auth.post("/change-password", requireAuth("user", { allowPasswordChange: true }), async (c) => {
  const input = await parseBody(c, ChangePasswordSchema);
  const user = c.get("user");
  const row = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", user.id);
  if (!row) throw notFound();
  if (!user.must_change_password) {
    if (!input.current_password || !(await verifyPassword(input.current_password, row.password_hash))) {
      throw badRequest("password_wrong", { current_password: "wrong" });
    }
  }
  await stmt(c.env.DB, "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?", await hashPassword(input.new_password, pbkdf2Iterations(c.env)), now(), user.id).run();
  await audit(c.env.DB, { actor_id: user.id, actor_label: user.name, action: "auth.password_changed", entity_type: "user", entity_id: user.id, ip: c.get("ip") });
  return c.json(await meResponse(c.env, { ...user, must_change_password: false }, c.get("csrf")));
});

auth.post("/forgot-password", async (c) => {
  const ip = c.get("ip");
  if (!(await rateLimit(c.env, `forgot:${ip}`, 5, 300))) throw new ApiError(429, "rate_limited");
  const input = await parseBody(c, ForgotPasswordSchema);
  const u = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE email = ? AND is_active = 1", input.email);
  const settings = await loadSettings(c.env);
  if (u && emailAvailable(c.env, settings)) {
    const token = randomToken(24);
    await c.env.KV.put(`pwreset:${token}`, u.id, { expirationTtl: 3600 });
    const link = `${settings.public_base_url || c.env.PUBLIC_BASE_URL}/reset-password?token=${token}`;
    await sendEmail(c.env, u.email, t(u.language, "email.reset.subject", { org: settings.org_name }), t(u.language, "email.reset.body", { name: u.name, link }));
    await audit(c.env.DB, { actor_id: u.id, actor_label: u.email, action: "auth.reset_requested", entity_type: "user", entity_id: u.id, ip });
  }
  // Always OK to avoid account enumeration.
  return c.json({ ok: true, email_enabled: emailAvailable(c.env, settings) });
});

auth.post("/reset-password", async (c) => {
  const input = await parseBody(c, ResetPasswordSchema);
  const userId = await c.env.KV.get(`pwreset:${input.token}`);
  if (!userId) throw badRequest("invalid_token");
  const u = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ? AND is_active = 1", userId);
  if (!u) throw badRequest("invalid_token");
  await stmt(c.env.DB, "UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?", await hashPassword(input.new_password, pbkdf2Iterations(c.env)), now(), u.id).run();
  await c.env.KV.delete(`pwreset:${input.token}`);
  await audit(c.env.DB, { actor_id: u.id, actor_label: u.name, action: "auth.password_reset", entity_type: "user", entity_id: u.id, ip: c.get("ip") });
  const session = await createSession(c.env, u.id, c.get("ip"));
  setSessionCookie(c, session.id);
  const user: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role, language: u.language, must_change_password: false };
  return c.json(await meResponse(c.env, user, session.csrf));
});

export default auth;
