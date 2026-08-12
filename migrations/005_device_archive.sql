-- Baja reversible de equipos. Al archivar se ocultan de la flotilla, pero se
-- conserva todo su historial; volver a dar de alta el mismo IMEI lo restaura.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_visible_idx
  ON devices (imei) WHERE archived_at IS NULL;

