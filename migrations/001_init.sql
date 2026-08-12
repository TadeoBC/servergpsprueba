-- 001_init.sql — esquema base de atlyx-gps
-- Se aplica una sola vez; el runner (src/db/migrate.js) lleva el control en
-- la tabla schema_migrations. Nunca edites una migración ya aplicada: crea
-- una nueva con el siguiente número.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── devices ──────────────────────────────────────────────────────────────────
-- Un renglón por rastreador. Los equipos desconocidos se dan de alta solos con
-- activo = false (auto-registro), para descubrir equipos nuevos sin perder sus
-- reportes.
CREATE TABLE IF NOT EXISTS devices (
  id            SERIAL PRIMARY KEY,
  imei          TEXT NOT NULL UNIQUE,
  alias         TEXT,
  placa         TEXT,
  activo        BOOLEAN NOT NULL DEFAULT false,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN devices.activo IS
  'false = equipo auto-registrado todavía no confirmado por un humano';
COMMENT ON COLUMN devices.last_seen_at IS
  'Último contacto TCP del equipo (hora de servidor), aunque la trama no traiga posición';

-- ── positions ────────────────────────────────────────────────────────────────
-- geom es NULL cuando la trama no traía fix válido: igual guardamos el renglón
-- con raw_hex para poder re-decodificar después.
CREATE TABLE IF NOT EXISTS positions (
  id           BIGSERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  geom         geography(Point, 4326),
  speed_kmh    REAL,
  course       REAL,
  altitude     REAL,
  satellites   SMALLINT,
  valid        BOOLEAN NOT NULL DEFAULT false,
  device_time  TIMESTAMPTZ,
  server_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_hex      TEXT,
  protocol     TEXT,
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON COLUMN positions.device_time IS
  'Hora reportada por el equipo, en UTC. El S11L_LA está configurado con UTC:ON, '
  'así que el campo de fecha de la trama ya viene en UTC y se ignora su TimeZone.';
COMMENT ON COLUMN positions.raw_hex IS
  'Trama completa en hexadecimal, incluidos delimitadores. Red de seguridad para '
  're-decodificar histórico si se descubre que un campo se interpretó mal.';
COMMENT ON COLUMN positions.attributes IS
  'Campos secundarios decodificados. attributes.unmapped guarda los bytes que el '
  'decoder NO pudo mapear con certeza, para revisarlos en el panel de depuración.';

-- Anti-duplicado del búfer offline: cuando el equipo recupera señal reenvía las
-- posiciones que guardó, y llegan otra vez con la misma device_time. El INSERT
-- usa ON CONFLICT DO NOTHING contra esta restricción.
-- Nota: postgres considera los NULL distintos entre sí, así que las tramas sin
-- device_time (sin fix) no chocan y se guardan todas.
CREATE UNIQUE INDEX IF NOT EXISTS positions_device_time_uniq
  ON positions (device_id, device_time);

CREATE INDEX IF NOT EXISTS positions_geom_gist
  ON positions USING GIST (geom);

CREATE INDEX IF NOT EXISTS positions_device_time_desc
  ON positions (device_id, device_time DESC);

CREATE INDEX IF NOT EXISTS positions_device_server_time_desc
  ON positions (device_id, server_time DESC);

-- ── events ───────────────────────────────────────────────────────────────────
-- Alarmas, login, heartbeat, tramas no reconocidas, errores de CRC.
CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  position_id  BIGINT REFERENCES positions(id) ON DELETE SET NULL,
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_device_created_desc
  ON events (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS events_tipo_created_desc
  ON events (tipo, created_at DESC);
