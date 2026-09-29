import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Role } from "@shared/types";
import { hasRole } from "@shared/types";
import type { AppVariables, Env, SessionUser } from "../env";
import { ApiError, forbidden, unauthorized } from "./errors";
import { randomToken } from "./crypto";
import { one } from "./db";
import { pickLanguage } from "./i18n";

export const SESSION_COOKIE = "ff_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

interface StoredSession {
  user_id: string;
  csrf: string;
  created_at: string;
  ip: string;
}

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function createSession(env: Env, userId: string, ip: string): Promise<{ id: string; csrf: string }> {
  const id = randomToken(32);
  const csrf = randomToken(16);
  const s: StoredSession = { user_id: userId, csrf, created_at: new Date().toISOString(), ip };
  await env.KV.put(`session:${id}`, JSON.stringify(s), { expirationTtl: SESSION_TTL_SECONDS });
  return { id, csrf };
}

export async function destroySession(env: Env, id: string): Promise<void> {
  await env.KV.delete(`session:${id}`);
}

export function setSessionCookie(c: Context, id: string): void {
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function loadUser(env: Env, userId: string): Promise<SessionUser | null> {
  const u = await one<{
    id: string;
    email: string;
    name: string;
    role: Role;
    language: "de" | "en";
    must_change_password: number;
    is_active: number;
    deleted_at: string | null;
  }>(env.DB, "SELECT id, email, name, role, language, must_change_password, is_active, deleted_at FROM users WHERE id = ?", userId);
  if (!u || !u.is_active || u.deleted_at) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    language: u.language,
    must_change_password: u.must_change_password === 1,
  };
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

/** Resolves the session (if any) without failing. Sets lang for error messages. */
export const sessionMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  c.set("ip", clientIp(c));
  const sid = getCookie(c, SESSION_COOKIE);
  let lang = pickLanguage(c.req.header("accept-language"));
  if (sid) {
    const s = await c.env.KV.get<StoredSession>(`session:${sid}`, "json");
    if (s) {
      const user = await loadUser(c.env, s.user_id);
      if (user) {
        c.set("user", user);
        c.set("session_id", sid);
        c.set("csrf", s.csrf);
        lang = user.language;
      }
    }
  }
  c.set("lang", lang);
  await next();
};

/** Requires a signed-in user; enforces CSRF on mutating requests. */
export function requireAuth(minRole: Role = "user", opts: { allowPasswordChange?: boolean } = {}): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) throw unauthorized();
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const header = c.req.header("x-csrf-token");
      if (!header || header !== c.get("csrf")) throw new ApiError(403, "csrf");
    }
    if (user.must_change_password && !opts.allowPasswordChange) throw new ApiError(403, "must_change_password");
    if (!hasRole(user.role, minRole)) throw forbidden();
    await next();
  };
}

/** Simple fixed-window rate limiter backed by KV. */
export async function rateLimit(env: Env, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const k = `rl:${key}:${bucket}`;
  const current = Number((await env.KV.get(k)) ?? 0);
  if (current >= limit) return false;
  await env.KV.put(k, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}
