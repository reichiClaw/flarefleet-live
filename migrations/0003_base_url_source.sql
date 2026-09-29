-- The first-run setup used to record the URL the app was reached at in the same
-- key the super admin edits (public_base_url), where it outranked PUBLIC_BASE_URL
-- from the deploy configuration. A deployment that started on its workers.dev
-- address could therefore never be moved to a custom domain by configuration.
-- Those auto-recorded addresses move to the separate, lowest-precedence key; a
-- value typed into Settings stays where it is.
INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at)
SELECT 'public_base_url_detected', value, updated_by, updated_at
FROM settings
WHERE key = 'public_base_url' AND value LIKE '%workers.dev%';

DELETE FROM settings WHERE key = 'public_base_url' AND value LIKE '%workers.dev%';
