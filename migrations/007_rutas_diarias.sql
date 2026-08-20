-- 007_rutas_diarias.sql — histórico de recorridos por día natural.
--
-- Hasta ahora el recorrido se recalculaba siempre desde `positions` con una
-- ventana deslizante (las últimas seis horas). Eso tenía dos consecuencias
-- molestas en operación:
--   · al cruzar la medianoche el mapa seguía arrastrando el trayecto del día
--     anterior, y nunca se veía "limpio" al empezar la jornada;
--   · no existía forma de consultar "la ruta del martes" sin volver a recorrer
--     el histórico completo y repetir el ajuste a calles.
--
-- Esta tabla guarda un renglón por equipo y día local ya consolidado: la
-- geometría en tramos (MultiLineString, para que los cortes por apagón se
-- conserven) más las métricas que la interfaz necesita para listar los días.
--
-- El día es LOCAL, no UTC: una jornada que termina a las 23:30 hora de México
-- caería en el día siguiente si se agrupara por UTC. Por eso se guarda también
-- la zona horaria con la que se calculó, de modo que un cambio de configuración
-- sea detectable en lugar de corromper el histórico en silencio.

CREATE TABLE IF NOT EXISTS daily_routes (
  id                BIGSERIAL PRIMARY KEY,
  device_id         INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  fecha             DATE NOT NULL,
  zona_horaria      TEXT NOT NULL,
  geom              geometry(MultiLineString, 4326),
  distancia_km      REAL NOT NULL DEFAULT 0,
  puntos            INTEGER NOT NULL DEFAULT 0,
  tramos            INTEGER NOT NULL DEFAULT 0,
  paradas           INTEGER NOT NULL DEFAULT 0,
  velocidad_max_kmh REAL,
  primer_punto      TIMESTAMPTZ,
  ultimo_punto      TIMESTAMPTZ,
  ajustada_calles   BOOLEAN NOT NULL DEFAULT false,
  -- `cerrada` distingue el día en curso (se recalcula al vuelo) del día ya
  -- terminado (congelado). Sin esto habría que adivinar por la fecha.
  cerrada           BOOLEAN NOT NULL DEFAULT false,
  resumen           JSONB NOT NULL DEFAULT '{}'::jsonb,
  generada_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, fecha)
);

-- Listar los días disponibles de un equipo, del más reciente al más viejo.
CREATE INDEX IF NOT EXISTS daily_routes_device_fecha_desc
  ON daily_routes (device_id, fecha DESC);

-- Barrido del consolidador: buscar días vencidos que siguen sin cerrar.
CREATE INDEX IF NOT EXISTS daily_routes_pendientes
  ON daily_routes (fecha)
  WHERE cerrada = false;
