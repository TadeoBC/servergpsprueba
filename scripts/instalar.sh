#!/usr/bin/env bash
#
# instalar.sh — deja el sistema entero funcionando en un VPS nuevo.
#
#   git clone git@github.com:TadeoBC/servergpsprueba.git
#   cd servergpsprueba
#   sudo ./scripts/instalar.sh
#
# Hace, en este orden:
#   1. Docker y utilidades
#   2. .env (lo crea con secretos generados si no existe)
#   3. base de datos, aplicación y HTTPS
#   4. motor de rutas propio (el paso largo: descarga el callejero)
#   5. tareas programadas: respaldo diario y refresco del callejero
#
# Es idempotente: se puede volver a ejecutar sin romper nada. Lo que ya está
# hecho se detecta y se salta.
#
# Requiere Ubuntu 22.04 o 24.04 y unos 10 GB libres.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERDE='\033[0;32m'; AMBAR='\033[1;33m'; AZUL='\033[0;36m'; ROJO='\033[0;31m'; RESET='\033[0m'
paso()  { echo -e "\n${AZUL}==>${RESET} $*"; }
ok()    { echo -e "  ${VERDE}✔${RESET} $*"; }
avisa() { echo -e "  ${AMBAR}!${RESET} $*"; }
muere() { echo -e "  ${ROJO}✖${RESET} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || muere "ejecuta con sudo"

SALTAR_OSRM=${SALTAR_OSRM:-0}

# ── 1. dependencias ─────────────────────────────────────────────────────────
paso "1/5 · dependencias"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  ok "docker instalado"
else
  ok "docker ya estaba"
fi
docker compose version >/dev/null 2>&1 || muere "falta el plugin docker compose"
command -v osmium >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq osmium-tool; }
command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl
ok "utilidades listas"

# ── 2. configuración ────────────────────────────────────────────────────────
paso "2/5 · configuración"
if [ ! -f .env ]; then
  [ -f .env.example ] || muere "falta .env.example"
  cp .env.example .env
  # Los secretos no pueden quedarse con el valor de ejemplo.
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^AUTH_PASSWORD=.*|AUTH_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')|" .env
  chmod 600 .env
  ok ".env creado con secretos nuevos"
  avisa "revisa VIEW_DOMAIN, GPS_DOMAIN y ACME_EMAIL antes de exponerlo a internet"
  avisa "tu contraseña de acceso: $(grep '^AUTH_PASSWORD=' .env | cut -d= -f2-)"
else
  ok ".env ya existía, se respeta"
fi

# ── 3. servicios ────────────────────────────────────────────────────────────
paso "3/5 · base de datos, aplicación y HTTPS"
# El motor de rutas se levanta después: sin grafo no arrancaría y bloquearía a
# la app, que depende de él.
docker compose up -d --build db app caddy
ok "servicios arriba (las migraciones corren solas al arrancar)"

# ── 4. motor de rutas ───────────────────────────────────────────────────────
paso "4/5 · motor de rutas propio"
if [ "$SALTAR_OSRM" = "1" ]; then
  avisa "omitido por SALTAR_OSRM=1; se usará el servidor público de OSRM"
  sed -i "s|^MAP_MATCH_URL=.*|MAP_MATCH_URL=https://router.project-osrm.org|" .env
  docker compose up -d app
elif [ -s /opt/osrm/data/zona.osrm.mldgr ]; then
  ok "el grafo ya existe, se reutiliza"
  docker compose up -d osrm
else
  avisa "esto descarga cientos de MB y tarda un buen rato"
  ./scripts/osrm-local.sh
  docker compose up -d osrm
  ok "motor de rutas listo"
fi

# ── 5. tareas programadas ───────────────────────────────────────────────────
paso "5/5 · tareas programadas"
install -d -m 755 /etc/cron.d

# Respaldo diario de la base.
cat > /etc/cron.d/atlyx-gps-backup <<CRON
# Respaldo diario de atlyx-gps. Generado por scripts/instalar.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root cd $DIR && ./scripts/backup.sh >> $DIR/backups/backup.log 2>&1
CRON
ok "respaldo diario a las 03:00"

# Refresco del callejero. Mensual y de madrugada: es la tarea más pesada y el
# callejero no cambia tan rápido como para justificar más frecuencia.
if [ "$SALTAR_OSRM" != "1" ]; then
  install -d -m 755 /var/log/atlyx
  cat > /etc/cron.d/atlyx-osrm <<CRON
# Refresco mensual del callejero. Generado por scripts/instalar.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 4 1 * * root PROYECTO=$DIR $DIR/scripts/osrm-actualizar.sh >> /var/log/atlyx/osrm.log 2>&1
CRON
  ok "callejero se refresca el día 1 de cada mes a las 04:30"
fi

echo
echo -e "${VERDE}== instalación terminada ==${RESET}"
docker compose ps --format "  {{.Name}}: {{.Status}}"
echo
echo "Panel:     https://$(grep '^VIEW_DOMAIN=' .env | cut -d= -f2- || echo tu-dominio)"
echo "Usuario:   $(grep '^AUTH_USER=' .env | cut -d= -f2-)"
echo
avisa "en Google Cloud falta abrir el puerto de los rastreadores en las reglas de VPC;"
avisa "ufw dentro de la VM no basta. El detalle está en deploy.sh."
