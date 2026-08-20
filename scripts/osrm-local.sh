#!/usr/bin/env bash
#
# osrm-local.sh — monta el motor de rutas propio para el ajuste a calles.
#
# Por qué: el servidor público router.project-osrm.org es de demostración, con
# cuota y sin garantía de disponibilidad. En local el ajuste de un día completo
# tarda décimas de segundo, no depende de terceros y admite trazas mucho más
# largas (MAP_MATCH_MAX_POINTS deja de tener que ser conservador).
#
#   sudo ./scripts/osrm-local.sh
#
# Ojo con la memoria: procesar México entero pide 4-6 GB, y en una máquina de
# 3.8 GB compartida con otros servicios no cabe. Por eso se recorta la zona de
# operación antes de construir el grafo; medido así, el pico fue de 1.3 GB.
#
# Si la flotilla empieza a operar fuera del recorte, amplía BBOX y vuelve a
# ejecutarlo: fuera de esa caja no hay callejero y el ajuste caería al respaldo.
#
# El perfil es el de coche, que es el que corresponde a reparto en calle:
# respeta sentidos únicos y restricciones de giro, y eso es justo lo que evita
# que la línea trazada aparezca circulando en dirección contraria.
set -euo pipefail

DATA=${DATA:-/opt/osrm/data}
IMG=${IMG:-ghcr.io/project-osrm/osrm-backend:latest}
PAIS=${PAIS:-https://download.geofabrik.de/north-america/mexico-latest.osm.pbf}
# Querétaro y alrededores: San Juan del Río, la capital, el Bajío, Hidalgo y el
# norte del Valle de México.
BBOX=${BBOX:--101.6,19.2,-98.6,21.9}

command -v osmium >/dev/null 2>&1 || apt-get install -y osmium-tool

mkdir -p "$DATA"
cd "$DATA"

echo "== descargando callejero (son cientos de MB, tarda) =="
curl -fSL --progress-bar -o pais.osm.pbf "$PAIS"

echo "== recortando la zona de operación =="
osmium extract --bbox "$BBOX" --overwrite -o zona.osm.pbf pais.osm.pbf

echo "== construyendo el grafo =="
docker pull "$IMG"
# MLD en vez de CH: bastante menos memoria al preparar y al servir, que es lo
# que decide en esta máquina.
docker run --rm -v "$DATA:/data" "$IMG" osrm-extract -p /opt/car.lua /data/zona.osm.pbf
docker run --rm -v "$DATA:/data" "$IMG" osrm-partition /data/zona.osrm
docker run --rm -v "$DATA:/data" "$IMG" osrm-customize /data/zona.osrm

# Los .pbf ya no hacen falta y ocupan bastante.
rm -f pais.osm.pbf zona.osm.pbf

echo "== listo: $(du -sh "$DATA" | cut -f1) =="
echo "Levanta el servicio con:  docker compose up -d osrm"
echo "Y apunta la app con:      MAP_MATCH_URL=http://osrm:5000"
