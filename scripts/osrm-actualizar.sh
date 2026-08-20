#!/usr/bin/env bash
#
# osrm-actualizar.sh — rehace el grafo de calles con el callejero más reciente.
#
# OpenStreetMap cambia todos los días: calles nuevas, sentidos que se invierten,
# cierres. Un grafo viejo hace que el ajuste pegue los recorridos a una realidad
# que ya no existe, y eso se nota justo en lo que más cuesta afinar: los
# sentidos de circulación.
#
# Pensado para cron. Se ejecuta solo, y su regla principal es no dejar nunca el
# servicio peor de como lo encontró:
#
#   · construye el grafo nuevo EN OTRO DIRECTORIO, con el servicio en marcha
#     sirviendo el viejo;
#   · solo si termina bien, cambia uno por otro y reinicia (segundos de corte);
#   · si algo falla, deja el grafo anterior intacto y sale con error;
#   · guarda el anterior para poder volver atrás.
#
# Uso manual:  sudo ./scripts/osrm-actualizar.sh
set -euo pipefail

BASE=${BASE:-/opt/osrm}
DATA=${DATA:-$BASE/data}
NUEVO=$BASE/data.nuevo
PREVIO=$BASE/data.previo
IMG=${IMG:-ghcr.io/project-osrm/osrm-backend:latest}
PAIS=${PAIS:-https://download.geofabrik.de/north-america/mexico-latest.osm.pbf}
BBOX=${BBOX:--101.6,19.2,-98.6,21.9}
PROYECTO=${PROYECTO:-/home/yei_pagos/servergpsprueba}
# Margen de disco exigido antes de empezar: el callejero de un país pesa cientos
# de MB y el grafo intermedio bastante más.
MIN_LIBRE_MB=${MIN_LIBRE_MB:-4000}

registrar() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

fallar() {
  registrar "ERROR: $*"
  rm -rf "$NUEVO"
  registrar "el grafo anterior sigue en servicio, sin cambios"
  exit 1
}

registrar "== actualización del callejero =="

libre=$(df -Pm "$BASE" | awk 'NR==2 {print $4}')
[ "$libre" -ge "$MIN_LIBRE_MB" ] || fallar "solo quedan ${libre} MB libres, hacen falta ${MIN_LIBRE_MB}"
registrar "disco disponible: ${libre} MB"

command -v osmium >/dev/null 2>&1 || fallar "falta osmium-tool (apt-get install osmium-tool)"

rm -rf "$NUEVO"
mkdir -p "$NUEVO"
cd "$NUEVO"

registrar "descargando callejero"
curl -fsSL --retry 3 --retry-delay 30 -o pais.osm.pbf "$PAIS" || fallar "no se pudo descargar el callejero"

# Un PBF truncado pasa el curl pero revienta después: se comprueba ahora.
osmium fileinfo pais.osm.pbf >/dev/null 2>&1 || fallar "el archivo descargado no es un PBF válido"
registrar "descargado: $(du -h pais.osm.pbf | cut -f1)"

registrar "recortando la zona de operación"
osmium extract --bbox "$BBOX" --overwrite -o zona.osm.pbf pais.osm.pbf || fallar "falló el recorte"
rm -f pais.osm.pbf

registrar "construyendo el grafo"
docker pull -q "$IMG" >/dev/null 2>&1 || registrar "aviso: no se pudo refrescar la imagen, se usa la local"
docker run --rm -v "$NUEVO:/data" "$IMG" osrm-extract -p /opt/car.lua /data/zona.osm.pbf >/dev/null 2>&1 || fallar "falló osrm-extract"
docker run --rm -v "$NUEVO:/data" "$IMG" osrm-partition /data/zona.osrm >/dev/null 2>&1 || fallar "falló osrm-partition"
docker run --rm -v "$NUEVO:/data" "$IMG" osrm-customize /data/zona.osrm >/dev/null 2>&1 || fallar "falló osrm-customize"
rm -f zona.osm.pbf

# Comprobación mínima antes de dar el cambiazo: sin estos archivos el servicio
# no arrancaría y nos quedaríamos sin motor.
for archivo in zona.osrm.mldgr zona.osrm.cell_metrics zona.osrm.fileIndex; do
  [ -s "$NUEVO/$archivo" ] || fallar "el grafo nuevo está incompleto (falta $archivo)"
done
registrar "grafo nuevo listo: $(du -sh "$NUEVO" | cut -f1)"

registrar "cambiando al grafo nuevo"
rm -rf "$PREVIO"
[ -d "$DATA" ] && mv "$DATA" "$PREVIO"
mv "$NUEVO" "$DATA"

cd "$PROYECTO"
if ! docker compose up -d --force-recreate osrm >/dev/null 2>&1; then
  registrar "el servicio no arrancó con el grafo nuevo, volviendo al anterior"
  rm -rf "$DATA"
  mv "$PREVIO" "$DATA"
  docker compose up -d --force-recreate osrm >/dev/null 2>&1 || true
  fallar "revertido al grafo anterior"
fi

# Se comprueba que responde de verdad, no solo que el contenedor esté en pie.
sleep 20
if ! docker compose exec -T app node -e "fetch('http://osrm:5000/route/v1/driving/-99.9626,20.3782;-99.96,20.38?overview=false').then(r=>r.json()).then(d=>process.exit(d.code==='Ok'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  registrar "el motor no responde con el grafo nuevo, volviendo al anterior"
  rm -rf "$DATA"
  mv "$PREVIO" "$DATA"
  docker compose up -d --force-recreate osrm >/dev/null 2>&1 || true
  fallar "revertido al grafo anterior"
fi

registrar "== actualizado y respondiendo correctamente =="
registrar "el grafo anterior queda en $PREVIO por si hay que volver atrás"
