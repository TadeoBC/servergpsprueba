# Mejoras de rastreo y operación

## Posición y estela

El mapa conserva la última coordenada válida si un heartbeat o un paquete sin
fix llega después. Al seleccionar un equipo carga automáticamente seis horas de
recorrido y continúa extendiendo la línea con las posiciones recibidas por
WebSocket. Los botones permiten consultar 1 h, 6 h, 24 h o 7 días.

## Telemetría

La batería, señal GSM, ACC, estado de fix y odómetro se almacenan en
`devices.telemetry`. Ya no dependen de que la última trama sea precisamente un
heartbeat. El firmware S11L observado informa batería en escala cruda 0–15,
mientras el GT06 clásico usa 0–6; el decoder admite ambas y marca el porcentaje
como aproximado.

En las tramas reales `0x12` del S11L, los cuatro bytes posteriores a LBS se
interpretan como odómetro extendido. Se conserva `valor_crudo` y se muestra una
estimación en kilómetros asumiendo metros, porque ciertos firmwares permiten
cambiar esa unidad.

## Alertas

Cada equipo acepta `speed_limit_kmh`. El servidor crea un evento al cruzar de
velocidad normal a exceso y otro al normalizarse; no genera una alerta repetida
en cada pulsación mientras continúa excedido. La entrada se difunde en vivo al
panel. Las alarmas originadas por el propio rastreador también se difunden y el
usuario puede habilitar notificaciones del navegador.

## Comandos remotos S11L

El servidor implementa `0x80` (servidor a equipo) y correlaciona respuestas
`0x15`/`0x21` por el `server_flag` de cuatro bytes. La cola es durable: si el
equipo está offline entrega el comando tras su próximo login. Estados posibles:
`queued`, `sent`, `acknowledged`, `failed` y `expired`.

Solo se aceptan instrucciones documentadas para S11L:

- `TIMER,T1#`, entre 5 y 18 000 segundos.
- `HBT,T#`, entre 1 y 1 440 minutos.
- `PARAM#` y `STATUS#`.
- `SENALM,ON|OFF,M#` y `BATALM,ON|OFF,M#`, con modo 0–3.

No existe endpoint para texto arbitrario. Reinicio, cambio de servidor/APN y
acciones sobre motor quedan excluidos para evitar perder conectividad o afectar
un vehículo por accidente. La especificación detallada está en
[`COMANDOS_S11L.md`](COMANDOS_S11L.md).

## Aplicación segura de cambios

Las migraciones son aditivas y se ejecutan al arrancar. Antes de producción:

```bash
docker compose exec db pg_dump -U atlyx -d atlyx_gps -Fc -f /tmp/antes-mejoras.dump
docker compose up -d --build
docker compose logs -f app
```

Verifica `/api/health`, el marcador, batería, una ruta y luego genera la clave
API. Antes de usar alarmas con modo SMS/llamada, configura y comprueba el número
central del dispositivo según el proveedor de la SIM.

## Seguimiento avanzado y mapas

La barra superior del mapa permite cambiar entre cinco fondos (`Dark Matter`,
`Fiord`, `Claro limpio`, `Satélite` y `Calles clásico`), mantener centrado el equipo seleccionado con `Seguir`,
activar una perspectiva aérea 3D con terreno y abrir un mosaico de varios GPS.
Los equipos del mosaico se eligen con el botón `◎` de cada renglón; la selección
y el tema quedan guardados en el navegador.

Fiord, Dark Matter y Claro limpio son estilos vectoriales servidos por
OpenFreeMap sobre el esquema OpenMapTiles. Se renderizan con MapLibre dentro de
Leaflet, por lo que conservan marcadores, estela y mosaico, pero se ven nítidos
en pantallas Retina. La atribución a OpenFreeMap, OpenMapTiles y OpenStreetMap
permanece visible. Si el plugin vectorial no carga, se usa Calles clásico como
fallback y la operación GPS no se interrumpe.

Al cargar un recorrido, `Ajustar estela a calles` solicita
`ajustar_calles=1`. El servidor:

1. elimina duplicados menores a un metro y saltos físicamente imposibles;
2. separa periodos de más de diez minutos sin señal;
3. consulta el servicio Match de OSRM en bloques pequeños;
4. conserva como GPS filtrado únicamente los bloques que OSRM no pudo ajustar.

El ajuste tiene un límite total de tiempo y nunca impide mostrar el recorrido.
El OSRM público es útil para pruebas; para una flotilla en producción se
recomienda desplegar uno propio y configurar `MAP_MATCH_URL`.

## Interfaz móvil

En pantallas de hasta 820 px el mapa ocupa todo el viewport y el panel se
convierte en una hoja inferior. La barra fija permite saltar entre Mapa,
Equipos, GPS y Ruta; el asa y el botón de flecha abren o cierran el panel. Los
controles respetan las áreas seguras de iPhone, usan blancos táctiles grandes y
recalculan el tamaño de Leaflet/MapLibre al girar el teléfono o abrir el teclado.
En horizontal, el panel cambia a hoja lateral para conservar altura útil.

`manifest.webmanifest` y los metadatos de iOS permiten agregar el panel a la
pantalla de inicio y abrirlo con apariencia de aplicación independiente. Esto
no lo convierte en una app nativa: continúa siendo la misma web responsive y
requiere conexión con el servidor.
