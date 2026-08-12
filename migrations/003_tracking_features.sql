-- Estado persistente, reglas operativas y acceso de integración.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS speed_limit_kmh REAL,
  ADD COLUMN IF NOT EXISTS report_interval_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS telemetry_updated_at TIMESTAMPTZ;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_speed_limit_check;
ALTER TABLE devices ADD CONSTRAINT devices_speed_limit_check
  CHECK (speed_limit_kmh IS NULL OR speed_limit_kmh BETWEEN 1 AND 300);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_report_interval_check;
ALTER TABLE devices ADD CONSTRAINT devices_report_interval_check
  CHECK (report_interval_seconds IS NULL OR report_interval_seconds BETWEEN 10 AND 86400);

CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['read'],
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_active_hash_idx
  ON api_keys (key_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_alert_state (
  device_id      INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  speeding       BOOLEAN NOT NULL DEFAULT false,
  speeding_since TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

