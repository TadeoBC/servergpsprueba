#!/usr/bin/env bash
#
# backup.sh — respaldo diario de la base con rotación a 7 días.
#
# Lo instala deploy.sh en el cron (03:00). También se puede correr a mano:
#   ./scripts/backup.sh
#
# El volcado se hace con pg_dump en formato "custom" (-Fc), que se restaura con
# pg_restore y permite recuperar tablas sueltas.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a

PG_USER="${POSTGRES_USER:-atlyx}"
PG_DB="${POSTGRES_DB:-atlyx_gps}"
DESTINO="${DIR}/backups"
RETENCION_DIAS=7

mkdir -p "$DESTINO"

SELLO="$(date +%Y%m%d_%H%M%S)"
ARCHIVO="${DESTINO}/atlyx_gps_${SELLO}.dump"

echo "[$(date -Iseconds)] iniciando respaldo de ${PG_DB}"

# El volcado se escribe a stdout desde el contenedor y se guarda en el host,
# así el respaldo no depende de que el volumen del contenedor siga existiendo.
if ! docker compose exec -T db pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$ARCHIVO"; then
  echo "[$(date -Iseconds)] ERROR: pg_dump falló" >&2
  rm -f "$ARCHIVO"
  exit 1
fi

# Un volcado vacío es señal de que algo salió mal; mejor detectarlo hoy que el
# día que haya que restaurar.
TAMANO=$(wc -c < "$ARCHIVO")
if [[ "$TAMANO" -lt 1024 ]]; then
  echo "[$(date -Iseconds)] ERROR: el respaldo pesa solo ${TAMANO} bytes, se descarta" >&2
  rm -f "$ARCHIVO"
  exit 1
fi

gzip -f "$ARCHIVO"
echo "[$(date -Iseconds)] respaldo listo: ${ARCHIVO}.gz ($(du -h "${ARCHIVO}.gz" | cut -f1))"

# ── rotación ─────────────────────────────────────────────────────────────────
BORRADOS=$(find "$DESTINO" -name 'atlyx_gps_*.dump.gz' -type f -mtime "+${RETENCION_DIAS}" -print -delete | wc -l)
[[ "$BORRADOS" -gt 0 ]] && echo "[$(date -Iseconds)] rotación: ${BORRADOS} respaldo(s) de más de ${RETENCION_DIAS} días eliminados"

echo "[$(date -Iseconds)] respaldos guardados: $(find "$DESTINO" -name 'atlyx_gps_*.dump.gz' | wc -l)"

# ── cómo restaurar ───────────────────────────────────────────────────────────
# 1. Descomprimir:   gunzip atlyx_gps_AAAAMMDD_HHMMSS.dump.gz
# 2. Copiar al contenedor y restaurar:
#      docker compose cp atlyx_gps_....dump db:/tmp/restaurar.dump
#      docker compose exec db pg_restore -U atlyx -d atlyx_gps --clean --if-exists /tmp/restaurar.dump
