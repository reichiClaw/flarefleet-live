-- Pre-reservations: a planned loan window that exists before any protocol does.
-- They hold a vehicle for a borrower ("the Iveco is out next Tuesday and
-- Wednesday") and are turned into a real loan at checkout time, which is why they
-- live next to loans instead of inside them: a plan carries no evidence, no
-- readings and no photos, and may be dropped without leaving a protocol behind.
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  company_id TEXT REFERENCES companies(id),
  driver_id TEXT REFERENCES drivers(id),
  borrower_name TEXT NOT NULL,
  borrower_phone TEXT NOT NULL DEFAULT '',
  borrower_email TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','fulfilled','cancelled','expired')),
  loan_id TEXT REFERENCES loans(id),
  created_by TEXT NOT NULL,
  closed_by TEXT,
  close_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);

-- Overlap checks and the per-vehicle list read by vehicle and window.
CREATE INDEX reservations_vehicle_idx ON reservations(vehicle_id, status, starts_at);
-- The upcoming list and the hourly expiry read by window alone.
CREATE INDEX reservations_window_idx ON reservations(status, starts_at);
