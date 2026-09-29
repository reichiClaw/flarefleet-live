import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppVariables, Env } from "./env";
import { sessionMiddleware } from "./lib/auth";
import { ApiError } from "./lib/errors";
import { pickLanguage } from "./lib/i18n";
import auth from "./routes/auth";
import users from "./routes/users";
import settings from "./routes/settings";
import master from "./routes/master";
import vehicles from "./routes/vehicles";
import protocols from "./routes/protocols";
import media from "./routes/media";
import imports from "./routes/imports";
import dashboard from "./routes/dashboard";
import audit from "./routes/audit";
import pub from "./routes/public";
import { daily, hourly } from "./cron";

export { VehicleLock } from "./services/lock";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: undefined }));
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
});
app.use("/api/*", sessionMiddleware);

app.route("/api/auth", auth);
app.route("/api/users", users);
app.route("/api/settings", settings);
app.route("/api", master);
app.route("/api/vehicles", vehicles);
app.route("/api/protocols", protocols);
app.route("/api/media", media);
app.route("/api/imports", imports);
app.route("/api/dashboard", dashboard);
app.route("/api/audit", audit);
app.route("/api/public", pub);

app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME, time: new Date().toISOString() }));

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) return new ApiError(404, "not_found").toResponse(c.get("lang") ?? "de");
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  const lang = c.get("lang") ?? pickLanguage(c.req.header("accept-language"));
  if (err instanceof ApiError) return err.toResponse(lang);
  const msg = String((err as Error)?.message ?? err);
  // D1 uniqueness violations surface as generic errors; translate the common ones.
  if (/UNIQUE constraint failed: vehicles\.serial/.test(msg)) return new ApiError(409, "duplicate_serial").toResponse(lang);
  if (/UNIQUE constraint failed: vehicles\.license/.test(msg)) return new ApiError(409, "duplicate_plate").toResponse(lang);
  if (/UNIQUE constraint failed: vehicles\.internal/.test(msg)) return new ApiError(409, "duplicate_number").toResponse(lang);
  if (/UNIQUE constraint failed: users\.email/.test(msg)) return new ApiError(409, "email_taken").toResponse(lang);
  if (/UNIQUE constraint failed: loans/.test(msg)) return new ApiError(409, "active_loan").toResponse(lang);
  if (/UNIQUE constraint failed: categories\.name/.test(msg)) return new ApiError(409, "duplicate_name").toResponse(lang);
  // A dangling reference is bad input, not a server fault.
  if (/FOREIGN KEY constraint failed/.test(msg)) return new ApiError(400, "invalid_reference").toResponse(lang);
  console.error("unhandled", err);
  return new ApiError(500, "internal").toResponse(lang);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "0 6 * * *") ctx.waitUntil(daily(env));
    else ctx.waitUntil(hourly(env));
  },
} satisfies ExportedHandler<Env>;
