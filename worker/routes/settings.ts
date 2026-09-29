import { Hono } from "hono";
import { SettingsSchema } from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { requireAuth } from "../lib/auth";
import { audit } from "../lib/audit";
import { loadSettings, loadStoredSettings, resolveBaseUrl, resolveSettings, saveSettings } from "../lib/settings";
import { emailAvailable, emailFrom, sendEmailDetailed } from "../lib/email";
import { one } from "../lib/db";

const settings = new Hono<{ Bindings: Env; Variables: AppVariables }>();
settings.use("*", requireAuth("super_admin"));

settings.get("/", async (c) => {
  // The form edits the stored values, so saving it cannot pin a value that was
  // only resolved from the deploy configuration.
  const stored = await loadStoredSettings(c.env);
  const { public_base_url_detected, ...form } = stored;
  const s = resolveSettings(c.env, stored);
  const base = resolveBaseUrl(c.env, stored);
  const users = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users WHERE is_active = 1 AND deleted_at IS NULL");
  const categories = await one<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM categories WHERE is_active = 1");
  return c.json({
    settings: form,
    system: {
      email_binding: !!c.env.EMAIL && c.env.EMAIL_ENABLED !== "false",
      email_available: emailAvailable(c.env, s),
      email_from: emailFrom(c.env, s),
      email_from_env: c.env.EMAIL_FROM,
      public_base_url: base.url,
      public_base_url_source: base.source,
      public_base_url_env: c.env.PUBLIC_BASE_URL,
      public_base_url_detected,
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
