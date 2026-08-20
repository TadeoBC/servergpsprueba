-- 006_indices_flotilla.sql — índices pensados para operar con la flotilla
-- completa conectada, no con uno o dos equipos de prueba.
--
-- Los dos índices de 001 (device_id + device_time, device_id + server_time) se
-- quedan cortos en cuanto la tabla crece:
--   · la "última posición conocida" filtra por valid = true y geom IS NOT NULL,
--     así que el planner tenía que ir descartando tramas sin fix una por una;
--   · el histórico ordena por COALESCE(device_time, server_time) —para no perder
--     puntos con fecha corrupta— y ninguna expresión indexada cubría eso, de
--     modo que cada carga de recorrido ordenaba en memoria todas las filas del
--     equipo.

-- Aviso operativo: el runner aplica cada migración dentro de una transacción,
-- así que estos CREATE INDEX no pueden ser CONCURRENTLY y bloquean las
-- escrituras de positions mientras se construyen. Con un histórico grande,
-- aplícala en una ventana de poco tráfico.

-- Última posición con fix de cada equipo: el índice parcial deja el renglón
-- bueno en la primera lectura.
CREATE INDEX IF NOT EXISTS positions_device_fix_server_time_desc
  ON positions (device_id, server_time DESC, id DESC)
  WHERE valid = true AND geom IS NOT NULL;

-- Ventanas de histórico (recorridos, exportaciones de la API pública).
CREATE INDEX IF NOT EXISTS positions_device_tiempo_efectivo_desc
  ON positions (device_id, (COALESCE(device_time, server_time)) DESC, id DESC);

-- Las estadísticas por omisión de PostgreSQL sobre positions se quedan pobres
-- cuando la tabla crece rápido y el planner acaba eligiendo un seq scan.
ALTER TABLE positions ALTER COLUMN device_id SET STATISTICS 500;
ANALYZE positions;
