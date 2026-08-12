#!/usr/bin/env bash
#
# deploy.sh — instala y arranca atlyx-gps desde un Ubuntu 22.04/24.04 limpio.
#
#   sudo ./deploy.sh
#
# Hace:
#   1. Docker Engine + plugin de compose
#   2. ufw (22, 80, 443, 5023)               ← capa (a) del cortafuegos
#   3. .env (lo crea si falta, con secretos generados)
#   4. docker compose build + up
#   5. cron de respaldo diario
#   6. IMPRIME los comandos de gcloud para las reglas de VPC ← capa (b)
#
# ATENCIÓN: en Google Cloud hay DOS cortafuegos independientes. Este script
# configura ufw dentro de la VM, pero NO puede crear las reglas de VPC del
# proyecto: eso se hace con gcloud y se imprime al final. Sin esa segunda capa
# el puerto queda cerrado aunque ufw esté abierto.

set -euo pipefail

ROJO='\033[0;31m'; VERDE='\033[0;32m'; AMBAR='\033[1;33m'; AZUL='\033[0;36m'
NEGRITA='\033[1m'; RESET='\033[0m'

info()  { echo -e "${AZUL}==>${RESET} $*"; }
ok()    { echo -e "${VERDE}  ✔${RESET} $*"; }
warn()  { echo -e "${AMBAR}  !${RESET} $*"; }
error() { echo -e "${ROJO}  ✖${RESET} $*" >&2; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PUERTO_TCP="${TCP_PORT:-5023}"

# ── 6. reglas de VPC — capa (b) ──────────────────────────────────────────────
#
# Este recordatorio es lo más importante que imprime el script, así que se monta
# en una trampa de salida: si el despliegue muere antes de llegar aquí, el aviso
# se imprime igual y no te quedas sin saber que falta abrir el firewall de VPC.
VPC_IMPRESO=0

recordatorio_vpc() {
  if [[ $VPC_IMPRESO -eq 1 ]]; then
    return 0
  fi
  VPC_IMPRESO=1

  local ip
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<IP-DEL-VPS>')"

  echo
  echo -e "${AMBAR}${NEGRITA}══════════════════════════════════════════════════════════════════════════${RESET}"
  echo -e "${AMBAR}${NEGRITA}  6/6 · FALTA LA SEGUNDA CAPA DE CORTAFUEGOS (reglas de VPC en GCP)${RESET}"
  echo -e "${AMBAR}${NEGRITA}══════════════════════════════════════════════════════════════════════════${RESET}"
  echo
  echo -e "  ufw ya está abierto DENTRO de la VM, pero Google Cloud filtra el tráfico"
  echo -e "  ${NEGRITA}antes${RESET} de que llegue a la máquina. Sin estas reglas el puerto ${PUERTO_TCP} sigue"
  echo -e "  bloqueado y el rastreador nunca va a conectar."
  echo
  echo -e "  ${NEGRITA}Ejecuta esto desde tu Mac (o en Cloud Shell), NO dentro de la VM:${RESET}"
  echo
  echo -e "${AZUL}  gcloud compute firewall-rules create allow-gps-tcp \\"
  echo -e "    --allow tcp:${PUERTO_TCP} --source-ranges 0.0.0.0/0 --description \"Ingesta GPS GT06\""
  echo
  echo -e "  gcloud compute firewall-rules create allow-http-https \\"
  echo -e "    --allow tcp:80,tcp:443 --source-ranges 0.0.0.0/0${RESET}"
  echo
  echo -e "  Para comprobar que quedaron:"
  echo -e "${AZUL}  gcloud compute firewall-rules list${RESET}"
  echo
  echo -e "${AMBAR}══════════════════════════════════════════════════════════════════════════${RESET}"
  echo
  echo -e "  IP pública de esta máquina:  ${NEGRITA}${ip}${RESET}"
  echo
  echo -e "  Siguientes pasos:"
  echo -e "   1. Crea las reglas de VPC de arriba."
  echo -e "   2. En Cloudflare:"
  echo -e "        ${NEGRITA}gps.atlyx.online${RESET}   A → ${ip}  ${AMBAR}NUBE GRIS (proxy DESACTIVADO)${RESET}"
  echo -e "        ${NEGRITA}view.atlyx.online${RESET}  A → ${ip}  ${AMBAR}NUBE NARANJA (proxy ACTIVADO)${RESET}"
  echo -e "   3. Genera la contraseña del panel:"
  echo -e "        ${AZUL}docker compose run --rm app node scripts/hash-password.js 'tu-password'${RESET}"
  echo -e "      pégala en .env como AUTH_PASSWORD_HASH, quita AUTH_PASSWORD y recarga:"
  echo -e "        ${AZUL}docker compose up -d${RESET}"
  echo -e "   4. Apunta el rastreador por SMS:"
  echo -e "        ${AZUL}SERVER,1,gps.atlyx.online,${PUERTO_TCP},0#${RESET}"
  echo -e "   5. Verifica todo:  ${AZUL}docker compose exec app node scripts/doctor.js${RESET}"
  echo
  echo -e "  Registros en vivo:  ${AZUL}docker compose logs -f app${RESET}"
  echo
}

# ── 0. comprobaciones previas ────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  error "Este script es para Ubuntu. En macOS solo necesitas: docker compose up -d"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  error "Ejecútalo con sudo:  sudo ./deploy.sh"
  exit 1
fi

# A partir de aquí el despliegue va en serio: si algo se cae, el recordatorio
# del firewall de VPC se imprime igual gracias a esta trampa.
trap recordatorio_vpc EXIT

USUARIO_REAL="${SUDO_USER:-root}"

info "Desplegando atlyx-gps en $(lsb_release -ds 2>/dev/null || echo Ubuntu)"

# ── 1. Docker ────────────────────────────────────────────────────────────────
info "1/6 · Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker y el plugin de compose ya estaban instalados ($(docker --version | cut -d, -f1))"
else
  info "Instalando Docker desde el repositorio oficial…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null

  systemctl enable --now docker
  ok "Docker instalado ($(docker --version | cut -d, -f1))"
fi

if [[ "$USUARIO_REAL" != "root" ]]; then
  usermod -aG docker "$USUARIO_REAL" || true
  ok "Usuario '$USUARIO_REAL' agregado al grupo docker (cierra y abre sesión para que aplique)"
fi

# ── 2. ufw — capa (a) del cortafuegos ────────────────────────────────────────
info "2/6 · Cortafuegos de la VM (ufw)"

if ! command -v ufw >/dev/null 2>&1; then
  apt-get install -y -qq ufw >/dev/null
fi

ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow 22/tcp   comment 'SSH'                >/dev/null
ufw allow 80/tcp   comment 'HTTP (ACME/Caddy)'  >/dev/null
ufw allow 443/tcp  comment 'HTTPS (interfaz)'   >/dev/null
ufw allow 443/udp  comment 'HTTP/3'             >/dev/null
ufw allow "${PUERTO_TCP}"/tcp comment 'Ingesta GPS' >/dev/null
ufw --force enable >/dev/null

ok "ufw activo: 22, 80, 443 (tcp/udp) y ${PUERTO_TCP} permitidos"
warn "ufw es SOLO la capa (a). La capa (b) —reglas de VPC de GCP— se imprime al final."

# ── 3. .env ──────────────────────────────────────────────────────────────────
info "3/6 · Configuración (.env)"

if [[ -f .env ]]; then
  ok ".env ya existe, no se toca"
else
  cp .env.example .env
  # Secretos generados en el momento: nunca valores de ejemplo en producción.
  PG_PASS="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
  SESSION="$(openssl rand -hex 32)"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASS}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION}|" .env
  chmod 600 .env
  chown "$USUARIO_REAL":"$USUARIO_REAL" .env 2>/dev/null || true
  ok ".env creado con POSTGRES_PASSWORD y SESSION_SECRET generados al azar"
  warn "FALTA la contraseña del panel. Genérala y pégala en .env:"
  echo -e "      ${AZUL}docker compose run --rm app node scripts/hash-password.js 'tu-password'${RESET}"
fi

# Aviso si quedó la contraseña de ejemplo.
if grep -q '^AUTH_PASSWORD=cambiame' .env 2>/dev/null && ! grep -q '^AUTH_PASSWORD_HASH=scrypt' .env 2>/dev/null; then
  warn "La contraseña del panel sigue siendo la de ejemplo ('cambiame'). Cámbiala antes de publicarlo."
fi

mkdir -p backups
chown "$USUARIO_REAL":"$USUARIO_REAL" backups 2>/dev/null || true

# ── 4. arranque ──────────────────────────────────────────────────────────────
info "4/6 · Construyendo y levantando los contenedores"

docker compose build
docker compose up -d

info "Esperando a que el servicio responda…"
LISTO=0
for _ in $(seq 1 30); do
  if docker compose exec -T app curl -fsS "http://127.0.0.1:${HTTP_PORT:-8080}/api/health" >/dev/null 2>&1; then
    LISTO=1
    break
  fi
  sleep 3
done

if [[ $LISTO -eq 1 ]]; then
  ok "El servicio responde en /api/health"
else
  warn "El servicio todavía no responde. Revisa:  docker compose logs -f app"
fi

# ── 5. respaldos ─────────────────────────────────────────────────────────────
info "5/6 · Respaldo diario"

# Este paso NO debe tumbar el despliegue: si falla, el servicio ya está arriba y
# lo único que se pierde es el respaldo automático. Por eso va dentro de una
# función que se llama con "|| true" y nunca propaga el error.
configurar_respaldo() {
  chmod +x scripts/backup.sh

  # Las imágenes mínimas de Ubuntu (las de GCP entre ellas) vienen SIN el
  # paquete cron, así que el binario `crontab` puede no existir. Instalamos el
  # demonio y usamos un archivo en /etc/cron.d en lugar de `crontab -`:
  # no necesita el binario, es idempotente y se ve de un vistazo.
  if ! dpkg -s cron >/dev/null 2>&1; then
    info "Instalando el demonio cron (no venía en la imagen)…"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null 2>&1 || {
      warn "No se pudo instalar cron. El respaldo automático queda pendiente."
      warn "Ejecútalo a mano cuando quieras:  cd ${DIR} && ./scripts/backup.sh"
      return 0
    }
  fi

  systemctl enable --now cron >/dev/null 2>&1 || true

  # Un archivo en /etc/cron.d lleva un campo extra: el usuario que lo ejecuta.
  # El nombre NO puede llevar puntos o cron lo ignora en silencio.
  cat > /etc/cron.d/atlyx-gps-backup <<EOF
# Respaldo diario de atlyx-gps. Lo instaló deploy.sh; puedes editarlo o borrarlo.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root cd ${DIR} && ./scripts/backup.sh >> ${DIR}/backups/backup.log 2>&1
EOF
  chmod 0644 /etc/cron.d/atlyx-gps-backup

  if systemctl is-active --quiet cron 2>/dev/null; then
    ok "Respaldo diario a las 03:00 con rotación a 7 días (/etc/cron.d/atlyx-gps-backup)"
  else
    warn "El archivo de cron quedó escrito, pero el demonio cron no está activo."
    warn "Actívalo con:  sudo systemctl enable --now cron"
  fi
}

configurar_respaldo || warn "El paso de respaldos falló, pero el servicio sigue arriba."


recordatorio_vpc
echo -e "${VERDE}${NEGRITA}Despliegue terminado.${RESET}"
echo
