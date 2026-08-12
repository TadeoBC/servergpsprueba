# API de integración atlyx GPS

La API externa vive bajo `https://view.atlyx.online/api/v1`. No usa la cookie
del panel. Usa una clave revocable en el encabezado HTTP:

```http
Authorization: Bearer atlyx_TU_CLAVE
```

Genera la clave desde **Integración API** en el panel. El secreto completo solo
se muestra una vez; la base guarda únicamente SHA-256. Si se pierde, revócala y
genera otra. No pongas la clave en query strings porque proxies e historiales
pueden registrarla.

## Endpoints

- `GET /api/v1/devices/:imei/last`: equipo, telemetría persistida y última
  posición GPS válida.
- `GET /api/v1/devices/:imei/positions`: recorrido en JSON.
- `GET /api/v1/devices/:imei/route.geojson`: recorrido como `LineString` o
  `MultiLineString` GeoJSON, listo para Leaflet, Mapbox o Google Maps. Admite
  `ajustar_calles=1`; las propiedades `matched_to_roads` y `partial_match`
  describen si la estela fue ajustada total o parcialmente a la red vial.
- `GET /api/v1/devices/:imei/events`: alarmas y cambios de estado.
- `GET /api/v1/devices/:imei/commands`: estado de comandos remotos, sin revelar
  el texto ni el usuario que los solicitó.

Los recorridos aceptan `desde`, `hasta` (ISO 8601), `limit` (máximo 5000) y
`solo_validas=1`. La ruta GeoJSON también admite `ajustar_calles=1` y cae a la
traza GPS filtrada si OSRM no responde. Los eventos aceptan `desde` y `limit`
(máximo 1000).

Las posiciones incluyen estado de movimiento derivado: `movement_state` vale
`moving` o `stopped`; una parada se confirma al tercer pulso consecutivo dentro
de 15 m. `stopped_pulses` contiene la cantidad detectada y `stopped_since` la
hora del primer pulso de la parada.

```bash
curl -H 'Authorization: Bearer atlyx_TU_CLAVE' \
  'https://view.atlyx.online/api/v1/devices/351840620204473/last'

curl -H 'Authorization: Bearer atlyx_TU_CLAVE' \
  'https://view.atlyx.online/api/v1/devices/351840620204473/route.geojson?desde=2026-08-12T00:00:00Z&hasta=2026-08-13T00:00:00Z'
```

## Administración (sesión del panel)

- `POST /api/api-keys` con `{ "name": "Mi sistema" }` crea una clave.
- `GET /api/api-keys` lista prefijos, uso, vencimiento y revocación.
- `DELETE /api/api-keys/:id` revoca una clave.
- `PATCH /api/devices/:imei/settings` configura `speed_limit_kmh` y
  `report_interval_seconds`.
- `GET /api/devices/:imei/commands` lista la cola y sus respuestas.
- `POST /api/devices/:imei/commands` valida y encola un comando permitido.
- `GET /api/commands/catalog` devuelve el catálogo admitido.

Ejemplo para aplicar un intervalo de 60 segundos al hardware:

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"type":"set_interval","params":{"seconds":60}}' \
  'https://view.atlyx.online/api/devices/351840620204473/commands'
```

La escritura de comandos requiere la sesión administrativa; una API key de
integración es deliberadamente de solo lectura.
