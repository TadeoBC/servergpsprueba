CREATE TABLE IF NOT EXISTS device_commands (
  id BIGSERIAL PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL,
  command_text TEXT NOT NULL,
  server_flag BIGINT NOT NULL UNIQUE CHECK (server_flag BETWEEN 1 AND 4294967295),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','acknowledged','failed','expired')),
  response_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS device_commands_device_created_idx
  ON device_commands (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_commands_pending_idx
  ON device_commands (device_id, created_at) WHERE status = 'queued';

