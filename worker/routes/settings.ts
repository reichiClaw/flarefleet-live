import { Hono } from "hono";
import { SettingsSchema } from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { requireAuth } from "../lib/auth";
import { audit } from "../lib/audit";
import { loadSettings, saveSettings } from "../lib/settings";
import { emailAvailable, emailFrom, sendEmailDetailed } from "../lib/email";
import { one } from "../lib/db";

const settings = new Hono<{ Bindings: Env; Variables: AppVariables }>();
settings.use("*", requireAuth("super_admin"));

settings.get("/", async (c) => {
  const s = await loadSettings(c.env);
  const users = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users WHERE is_active = 1");
  const categories = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM categories WHERE is_active = 1");
  return c.json({
    settings: s,
    system: {
      email_binding: !!c.env.EMAIL && c.env.EMAIL_ENABLED !== "false",
      email_available: emailAvailable(c.env, s),
      email_from: emailFrom(c.env, s),
      email_from_env: c.env.EMAIL_FROM,
      public_base_url_env: c.env.PUBLIC_BASE_URL,
      users: users?.c ?? 0,
      categories: categories?.c ?? 0,
    },
  });
});

settings.put("/", async (c) => {
  const input = await parseBody(c, SettingsSchema);
  const actor = c.get("user");
  const s = await saveSettings(c.env, input, actor.id);
  await audit(c.env.DB, { actor_id: actor.id, actor_label: actor.name, action: "settings.updated", entity_type: "settings", details: { changes: input }, ip: c.get("ip") });
  return c.json({ settings: s });
});

settings.post("/test-email", async (c) => {
  const actor = c.get("user");
  const s = await loadSettings(c.env);
  const r = await sendEmailDetailed(c.env, actor.email, `${s.org_name}: Test`, `E-mail sending works. Sent from ${emailFrom(c.env, s)} to ${actor.email}.`);
  return c.json({ ok: r.ok, error: r.error ?? null, from: emailFrom(c.env, s), available: emailAvailable(c.env, s) });
});

export default settings;
