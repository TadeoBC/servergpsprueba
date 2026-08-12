-- 002_device_seed.sql — alta del equipo conocido.
-- El auto-registro daría de alta este IMEI solo, pero con activo = false.
-- Aquí lo dejamos activo desde el inicio para que aparezca en la interfaz
-- antes de su primer reporte.

INSERT INTO devices (imei, alias, placa, activo)
VALUES ('351840620204473', 'Moto 1', NULL, true)
ON CONFLICT (imei) DO NOTHING;
