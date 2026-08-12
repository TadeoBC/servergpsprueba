# atlyx-gps

## 1. Qué es el proyecto y arquitectura

`atlyx-gps` es un servicio de rastreo GPS para una flotilla de motos. Recibe conexiones TCP de rastreadores, decodifica y persiste sus mensajes, y muestra las posiciones en una interfaz web en vivo.

La arquitectura real del repositorio es:

- **`app`**: aplicación Node.js 20. `src/tcp/server.js` escucha TCP crudo y detecta automáticamente GT06/GT06N, JT808 o GPS103; `src/ingest/pipeline.js` atribuye las tramas al equipo, guarda posiciones y eventos, y evita duplicar posiciones reenviadas desde el búfer offline. Express sirve la API y el panel en el puerto interno `8080`; el WebSocket autenticado `/ws` difunde posiciones y paquetes nuevos.
- **`db`**: PostgreSQL 16 con PostGIS 3.4. Guarda equipos, puntos geográficos, telemetría, eventos y el control de migraciones. Las migraciones se ejecutan automáticamente al arrancar la aplicación.
- **`caddy`**: Caddy 2 termina TLS para `view.atlyx.online`, redirige HTTP a HTTPS y hace `reverse_proxy` hacia `app:8080`, incluido el WebSocket. No interviene en la ingesta GPS.
- **Puerto `5023/tcp`**: se publica directamente desde `app`; los rastreadores hablan TCP crudo, no HTTP.
- **Interfaz web**: los archivos de `src/public/` consumen la API y el WebSocket. Salvo la pantalla de acceso y su CSS, el panel requiere una sesión válida.

En producción, `docker-compose.yml` levanta `db`, `app` y `caddy`. En desarrollo, `docker-compose.dev.yml` publica los servicios necesarios en el host, desactiva Caddy mediante el perfil `produccion` y permite usar HTTP local.

## 2. Setup en macOS con Docker Desktop

Requisitos: Docker Desktop en ejecución y un archivo `.env`. La plantilla documentada por el proyecto se prepara así:

```bash
cp .env.example .env
```

Para desarrollo local, revisa al menos `POSTGRES_PASSWORD`, `AUTH_USER`, `AUTH_PASSWORD` o `AUTH_PASSWORD_HASH`, y `SESSION_SECRET`. El hash de la contraseña del panel se genera con el script existente:

```bash
npm run hash-password -- 'tu-password'
```

Levanta la composición base junto con la sobrecapa de macOS mediante el comando exacto:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

La sobrecapa publica:

| Servicio | Acceso local | Mapeo |
|---|---|---|
| Web/API | `http://localhost:8088` | `8088:8080` |
| PostgreSQL/PostGIS | `localhost:5433` | `5433:5432` |
| Ingesta TCP | `localhost:5023` | `5023:5023` |

Los puertos del host se eligieron a propósito para no chocar con lo que ya
tengas corriendo en la Mac:

- **8088 en vez de 8080** — el `8080` es un puerto muy peleado. Si otra
  aplicación tuya ya registró un *service worker* en `http://localhost:8080`,
  el navegador te sirve **esa** aplicación en lugar de esta, sin avisar y sin
  que el servidor se entere. Si te llega a pasar, entra por `http://127.0.0.1:8088`
  (es otro origen y no arrastra service workers).
- **5433 en vez de 5432** — para no chocar con un PostgreSQL instalado en la Mac.

Puedes cambiar el puerto de la web con `DEV_HTTP_PORT` en el `.env`.

Atajos equivalentes ya definidos en `package.json`:

```bash
npm run dev:up      # levanta base + sobrecapa de desarrollo
npm run dev:logs    # sigue los logs de la aplicación
npm run dev:down    # apaga todo
```

La aplicación ejecuta las migraciones al arrancar. Para generar tráfico de prueba, ejecuta en otra terminal:

```bash
npm run simulate
```

El script existe en `package.json` y ejecuta `scripts/simulate.js`. Por defecto crea un rastreador falso GT06 con IMEI `351840620204473`, se conecta a `127.0.0.1:5023`, recorre un circuito urbano simulado por San Juan del Río, Querétaro, envía la primera posición un segundo después del login y después una posición cada 5 segundos. También envía un heartbeat cada 180 segundos, muestra las respuestas del servidor y vuelve a conectarse cinco segundos después de un corte. Lee `SIM_HOST`, `SIM_PORT`, `SIM_IMEI` y `SIM_INTERVAL_SECONDS`; asimismo admite las opciones implementadas `--host=`, `--puerto=`, `--imei=`, `--intervalo=`, `--equipos=`, `--jt808` y `--replay`.

## 3. Despliegue en Ubuntu 22.04/24.04 con `./deploy.sh`

El script exige Linux y privilegios de root. Desde la raíz del proyecto se ejecuta como indica su propio mensaje de validación:

```bash
sudo ./deploy.sh
```

`deploy.sh` realiza, en este orden, lo siguiente:

1. Comprueba que se ejecuta en Linux como root y determina el usuario que invocó `sudo`.
2. Comprueba Docker Engine y el plugin de Compose. Si faltan, configura el repositorio oficial de Docker para la versión de Ubuntu instalada e instala `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin` y `docker-compose-plugin`; después habilita Docker. También agrega el usuario real al grupo `docker`.
3. Instala `ufw` si hace falta, establece la política de entrada y salida y crea las reglas detalladas en la sección 5.
4. Si `.env` ya existe, lo conserva sin cambios. Si no existe, copia `.env.example`, genera valores aleatorios para `POSTGRES_PASSWORD` y `SESSION_SECRET`, aplica permisos `600` y entrega el archivo al usuario real. Advierte si falta generar `AUTH_PASSWORD_HASH` o si continúa la contraseña de ejemplo `AUTH_PASSWORD=cambiame`.
5. Crea `backups/` y ajusta su propietario al usuario real.
6. Ejecuta `docker compose build` y `docker compose up -d`.
7. Espera hasta 30 intentos, con pausas de 3 segundos, a que `app` responda en `http://127.0.0.1:8080/api/health` desde el propio contenedor. Si no responde, muestra una advertencia y remite a los logs.
8. Hace ejecutable `scripts/backup.sh` e instala, si aún no existe, una entrada en el crontab de root para ejecutar el respaldo todos los días a las `03:00`; la salida se acumula en `backups/backup.log`.
9. Consulta la IP pública mediante `api.ipify.org` y **solo imprime** las reglas `gcloud`, los registros DNS, el SMS de servidor, el comando de diagnóstico y los logs sugeridos. No crea reglas de VPC, registros DNS ni configura el rastreador.

## 4. DNS en Cloudflare

Configura exactamente estos dos registros:

| Nombre | Tipo | Valor | Proxy de Cloudflare |
|---|---|---|---|
| `gps.atlyx.online` | A | `34.174.220.57` | **DESACTIVADO** — nube gris / DNS only |
| `view.atlyx.online` | A | `34.174.220.57` | **ACTIVADO** — nube naranja |

> ⚠️ **ADVERTENCIA:** el proxy normal de Cloudflare solo atiende tráfico HTTP/HTTPS. La ingesta de `gps.atlyx.online` es TCP crudo en el puerto `5023`; si ese registro tuviera la nube naranja, resolvería a direcciones IP de Cloudflare y el tracker GPS jamás podría conectarse al servidor GT06. Debe permanecer en nube gris/DNS only.

`view.atlyx.online` sí sirve HTTP/HTTPS: Caddy escucha en `80` y `443`, obtiene y conserva los certificados, y reenvía el tráfico web a `app:8080`.

## 5. Doble capa de firewall en Google Cloud

> ⚠️ **ADVERTENCIA:** Google Cloud aplica dos cortafuegos independientes. Abrir un puerto en uno no lo abre en el otro. `deploy.sh` configura `ufw` dentro de la VM, pero **NO crea** las reglas de firewall de la VPC; únicamente imprime los comandos que deben ejecutarse manualmente desde una Mac o Cloud Shell.

La capa **(a), `ufw` dentro de la VM**, queda exactamente así:

- Política predeterminada: denegar tráfico entrante y permitir tráfico saliente.
- `22/tcp`: SSH.
- `80/tcp`: HTTP para ACME/Caddy y la redirección a HTTPS.
- `443/tcp`: HTTPS para la interfaz.
- `443/udp`: HTTP/3.
- `${TCP_PORT}/tcp`: ingesta GPS; si no se proporciona la variable al script, usa `5023`.
- `ufw` queda habilitado mediante `ufw --force enable`.

La capa **(b), reglas de VPC de Google Cloud**, se crea manualmente con los mismos comandos que imprime el script:

```bash
gcloud compute firewall-rules create allow-gps-tcp --allow tcp:5023 --source-ranges 0.0.0.0/0 --description "Ingesta GPS GT06"
gcloud compute firewall-rules create allow-http-https --allow tcp:80,tcp:443 --source-ranges 0.0.0.0/0
```

Los puertos TCP `80` y `443` son los necesarios para el sitio y el TLS configurados en `Caddyfile`. La composición también publica `443/udp` y `deploy.sh` lo permite en `ufw` para HTTP/3, pero el script no imprime ni crea una regla VPC UDP correspondiente; HTTP/3 es adicional y no es necesario para que HTTP/HTTPS funcione por TCP.

## 6. Configuración SMS del SEEWORLD S11L_LA

Equipo registrado por la migración `002_device_seed.sql`:

| Campo | Valor |
|---|---|
| Modelo | `SEEWORLD S11L_LA` |
| IMEI | `351840620204473` |
| Dominio de ingesta | `gps.atlyx.online` |
| Puerto | `5023/tcp` |
| Protocolo esperado | GT06/GT06N |

SMS para apuntar el equipo a este servidor:

```text
SERVER,1,gps.atlyx.online,5023,0#
```

Este comando sí aparece en `deploy.sh` y el destino coincide con `TCP_PORT=5023`, el puerto TCP publicado por Compose y el decoder GT06/GT06N de `src/protocols/gt06.js`. El mismo listener también puede detectar JT808 y GPS103, pero el simulador identifica GT06 como el protocolo esperado para el S11L_LA.

SMS de reversa a fábrica proporcionado para devolver el equipo a su plataforma original:

```text
SERVER,1,prot.locatebyteli.com,9000,0#
```

APN Telcel proporcionado:

| Campo | Valor |
|---|---|
| APN | `internet.itelcel.com` |
| Usuario | `webgprs` |
| Contraseña | `webgprs2002` |

Configuración operativa recomendada proporcionada para el tracker:

- `TIMER 60`
- `HBT 180`
- `UTC:ON`

> **Nota de verificación:** el repositorio corrobora `HBT 180` en el comportamiento del simulador y `UTC:ON` en el decoder GT06 y la migración inicial. No contiene documentación del firmware ni cadenas SMS para el APN, `TIMER`, `HBT`, `UTC:ON`, el servidor de reversa o su puerto `9000`; esos valores proceden de los datos operativos entregados con este proyecto. Por ello, aquí no se inventa una sintaxis SMS adicional: conviene contrastarla con el manual exacto del firmware S11L_LA antes de enviarla.

## 7. Endpoints de la API

`src/web/app.js` monta el router de `src/web/routes.js` bajo `/api`. Esta es la lista completa y exacta de rutas definidas allí:

| Método | Ruta | Autenticación | Comportamiento real |
|---|---|---|---|
| GET | `/api/health` | No | Devuelve hora del servidor, zona de la interfaz y puerto TCP; consulta PostgreSQL/PostGIS y responde `503` si la base falla. |
| POST | `/api/login` | No | Valida `usuario` y `password`, limita intentos fallidos por IP, crea la cookie de sesión si son correctos y devuelve `429`, `400` o `401` según el error. |
| POST | `/api/logout` | No | Elimina la cookie de sesión y devuelve `{ ok: true }`. |
| GET | `/api/session` | No | Indica si la petición tiene una sesión válida y, en ese caso, devuelve el usuario. |
| GET | `/api/config` | Sí | Devuelve zona horaria, umbrales de estado, dominios configurados y puerto TCP para el frontend. |
| GET | `/api/devices` | Sí | Lista todos los equipos con su última posición conocida, ordenados por alias e IMEI. |
| GET | `/api/devices/:imei/last` | Sí | Busca el equipo por IMEI y devuelve el equipo y su última posición; responde `404` si no existe. |
| GET | `/api/devices/:imei/positions` | Sí | Devuelve el histórico del equipo. Admite `desde` y `hasta` en ISO 8601, `limit` —100 por defecto y máximo 5000— y `solo_validas=1`; responde en orden cronológico ascendente. |
| GET | `/api/devices/:imei/debug` | Sí | Devuelve las últimas tramas decodificadas conservadas en memoria para ese IMEI. |
| GET | `/api/debug/sin-identificar` | Sí | Devuelve las últimas tramas en memoria que no pudieron atribuirse a un equipo. |
| POST | `/api/decode` | Sí | Limpia separadores de un campo JSON `hex`, valida longitud y tamaño, arma tramas completas y las decodifica sin modificar la base de datos. |

El WebSocket `/ws` no forma parte de `routes.js`: está definido en `src/web/ws.js`, exige la misma cookie de sesión y difunde posiciones y paquetes en vivo.

## 8. Esquema de la base de datos

`src/db/migrate.js` crea `schema_migrations` y aplica, en orden alfabético y dentro de transacciones, los archivos SQL de `migrations/`. Usa un advisory lock para evitar que dos instancias migren a la vez.

### `schema_migrations`

| Columna | Tipo y restricciones |
|---|---|
| `name` | `TEXT PRIMARY KEY` |
| `applied_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

### `devices`

| Columna | Tipo y restricciones |
|---|---|
| `id` | `SERIAL PRIMARY KEY` |
| `imei` | `TEXT NOT NULL UNIQUE` |
| `alias` | `TEXT` |
| `placa` | `TEXT` |
| `activo` | `BOOLEAN NOT NULL DEFAULT false` |
| `last_seen_at` | `TIMESTAMPTZ` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

Los IMEI desconocidos se autorregistran con `activo=false`. La migración `002_device_seed.sql` inserta `351840620204473`, alias `Moto 1`, placa nula y `activo=true`, sin sobrescribirlo si ya existe.

### `positions`

| Columna | Tipo y restricciones |
|---|---|
| `id` | `BIGSERIAL PRIMARY KEY` |
| `device_id` | `INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE` |
| `geom` | `geography(Point, 4326)` |
| `speed_kmh` | `REAL` |
| `course` | `REAL` |
| `altitude` | `REAL` |
| `satellites` | `SMALLINT` |
| `valid` | `BOOLEAN NOT NULL DEFAULT false` |
| `device_time` | `TIMESTAMPTZ` |
| `server_time` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |
| `raw_hex` | `TEXT` |
| `protocol` | `TEXT` |
| `attributes` | `JSONB NOT NULL DEFAULT '{}'::jsonb` |

La restricción única indexada sobre `(device_id, device_time)` permite descartar con `ON CONFLICT DO NOTHING` las posiciones reenviadas por el búfer offline. También existen índices GiST para `geom`, por `(device_id, device_time DESC)` y por `(device_id, server_time DESC)`. `geom` puede ser nulo cuando la trama no contiene un fix válido.

### `events`

| Columna | Tipo y restricciones |
|---|---|
| `id` | `BIGSERIAL PRIMARY KEY` |
| `device_id` | `INTEGER REFERENCES devices(id) ON DELETE CASCADE` |
| `tipo` | `TEXT NOT NULL` |
| `position_id` | `BIGINT REFERENCES positions(id) ON DELETE SET NULL` |
| `raw` | `JSONB NOT NULL DEFAULT '{}'::jsonb` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

Hay índices por `(device_id, created_at DESC)` y `(tipo, created_at DESC)`. La tabla conserva logins, registros, autenticaciones, alarmas, tramas desconocidas y tramas sin identificar según el pipeline de ingesta.

## 9. Diagnóstico con `npm run doctor`

El script `doctor` existe en `package.json` y ejecuta `scripts/doctor.js`:

```bash
npm run doctor
```

El diagnóstico comprueba:

1. Que exista una contraseña utilizable, el estado de `SESSION_SECRET`, `VPS_PUBLIC_IP` y la zona horaria.
2. La resolución IPv4 de `GPS_DOMAIN` y `VIEW_DOMAIN`. Descarga los rangos IPv4 oficiales de Cloudflare —o usa una copia local y lo advierte— para detectar si el dominio GPS está incorrectamente proxeado y si el dominio web usa la nube naranja.
3. Si algo escucha localmente en los puertos TCP y HTTP configurados, y si PostgreSQL/PostGIS y `schema_migrations` responden.
4. La alcanzabilidad **real desde internet** de `VPS_PUBLIC_IP:5023`: pide a `check-host.net` hasta tres nodos externos, consulta los resultados hasta ocho veces con intervalos de tres segundos y solo declara el puerto abierto cuando al menos un nodo externo logró conectarse. Si check-host.net no responde o no entrega resultados, informa `DESCONOCIDO`, nunca éxito.
5. Cuando no corre dentro del propio VPS, también intenta una conexión directa desde la máquina actual a la IP pública. Después prueba `GPS_DOMAIN:5023`, que es el destino que resolverá el tracker.
6. `https://VIEW_DOMAIN/api/health`, incluida la respuesta de PostGIS.

Al final recuerda las dos capas de firewall y resume resultados correctos, avisos, fallos y estados sin determinar. Sale con código `1` si hubo fallos, `0` si no los hubo y `2` ante un error fatal del propio doctor. Por eso esta prueba aporta más que comprobar únicamente que Node escucha en `127.0.0.1:5023`.

## 10. Respaldos y restauración

`scripts/backup.sh` no acepta flags de línea de comandos. Al ejecutarse desde cualquier ubicación, cambia a la raíz del proyecto, carga `.env` si existe y usa:

| Parámetro | Fuente y valor predeterminado |
|---|---|
| Usuario de PostgreSQL | `POSTGRES_USER`, predeterminado `atlyx` |
| Base de datos | `POSTGRES_DB`, predeterminado `atlyx_gps` |
| Destino | `backups/` dentro del proyecto; no es configurable |
| Retención | 7 días; `RETENCION_DIAS=7` está fijo en el script |

Ejecución manual:

```bash
./scripts/backup.sh
```

El script ejecuta `pg_dump` dentro del servicio Compose `db` con formato custom (`-Fc`), escribe primero `backups/atlyx_gps_AAAAMMDD_HHMMSS.dump` en el host y lo comprime como `.dump.gz`. Si `pg_dump` falla o el archivo mide menos de 1024 bytes, elimina el volcado incompleto y termina con error. Finalmente borra los archivos `atlyx_gps_*.dump.gz` de más de siete días. `deploy.sh` programa esta ejecución diariamente a las `03:00` y dirige el log a `backups/backup.log`.

No existe un script de restauración. El procedimiento documentado al final de `scripts/backup.sh`, aplicado a la ruta donde realmente guarda los archivos, es:

```bash
gunzip backups/atlyx_gps_AAAAMMDD_HHMMSS.dump.gz
docker compose cp backups/atlyx_gps_AAAAMMDD_HHMMSS.dump db:/tmp/restaurar.dump
docker compose exec db pg_restore -U atlyx -d atlyx_gps --clean --if-exists /tmp/restaurar.dump
```

Los valores `atlyx` y `atlyx_gps` son los predeterminados reales. Si `.env` define otros valores para `POSTGRES_USER` o `POSTGRES_DB`, deben usarse esos mismos valores en `pg_restore`. La opción `--clean --if-exists` elimina los objetos respaldados que ya existan antes de recrearlos desde el volcado custom.
