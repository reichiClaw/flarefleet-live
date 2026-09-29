-- User deletion. Protocols reference users (protocols.performed_by), so an account
-- that already signed off workflow steps cannot be removed without destroying the
-- evidence trail. Such accounts are marked deleted instead: they disappear from the
-- app, their sessions and logins stop working and their e-mail address is freed for
-- reuse, while the name stays readable in existing protocols.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE INDEX users_deleted_idx ON users(deleted_at, is_active, name);
