# Migrar a otro VPS

Guía para levantar el sistema completo en una máquina nueva y traerse el
histórico. Pensado para hacerlo de una sentada.

## Lo que hace falta

- Ubuntu 22.04 o 24.04
- **4 GB de RAM** como mínimo. Con menos, el motor de rutas no se puede
  preparar en la propia máquina (ver más abajo).
- **10 GB de disco** libres. El callejero y el grafo ocupan ~1,5 GB, y durante
  la preparación se llega a usar bastante más.
- Los dominios apuntando a la IP nueva **antes** de instalar: Caddy pide los
  certificados durante el arranque y falla si el DNS todavía apunta al viejo.

## 1. Instalar

```bash
git clone git@github.com:TadeoBC/servergpsprueba.git
cd servergpsprueba
sudo ./scripts/instalar.sh
```

Eso deja todo montado: Docker, la base, la aplicación, HTTPS, el motor de rutas
propio y las tareas programadas. Al terminar imprime la contraseña de acceso
generada — **anótala**, no se vuelve a mostrar.

Edita `.env` para ajustar `VIEW_DOMAIN`, `GPS_DOMAIN` y `ACME_EMAIL`, y reinicia
con `docker compose up -d`.

La parte larga es el callejero: son cientos de MB. Si prefieres dejar eso para
después y arrancar ya:

```bash
sudo SALTAR_OSRM=1 ./scripts/instalar.sh
```

Con eso el ajuste a calles usa el servidor público de OSRM, que funciona pero
tiene cuota y no garantiza disponibilidad. Cuando quieras el motor propio:

```bash
sudo ./scripts/osrm-local.sh
docker compose up -d osrm
# y en .env:  MAP_MATCH_URL=http://osrm:5000
```

## 2. Traerse el histórico

En el servidor viejo:

```bash
cd /home/yei_pagos/servergpsprueba
docker compose exec -T db pg_dump -U atlyx -d atlyx_gps -Fc | gzip > /tmp/atlyx.dump.gz
```

Cópialo a la máquina nueva (`scp`) y restaura:

```bash
gunzip -c atlyx.dump.gz | docker compose exec -T db pg_restore -U atlyx -d atlyx_gps --clean --if-exists
```

Las migraciones corren solas al arrancar, así que el esquema ya estará al día;
`--clean` evita chocar con las tablas vacías que creó el arranque.

## 3. Apuntar los rastreadores

Los GPS llevan grabada la dirección del servidor. Hasta que no se les cambie,
seguirán mandando datos al viejo. Se hace con un SMS al equipo, con el formato
que indique el fabricante del S11L.

**No apagues el servidor viejo hasta confirmar que llegan posiciones al nuevo.**
Mientras tanto pueden convivir: cada equipo reporta a donde tenga configurado.

## 4. Comprobar

```bash
docker compose ps                       # todo "healthy"
docker compose logs -f app              # posiciones entrando
curl -I https://TU_DOMINIO              # certificado correcto
```

En el panel: que los equipos aparezcan, que la batería muestre porcentaje y que
el recorrido del día se dibuje pegado a las calles.

## Detalles que suelen morder

**Puerto de los rastreadores.** En Google Cloud hay dos cortafuegos: `ufw`
dentro de la VM y las reglas de VPC del proyecto. `instalar.sh` no puede tocar
las segundas. En otros proveedores (Hostinger, Contabo, DigitalOcean) suele
bastar con `ufw`, que es una capa menos de la que preocuparse.

**Máquinas con poca RAM.** Preparar el grafo necesita ~1,3 GB con la zona
recortada. Si la máquina nueva va justa, prepáralo en otro sitio y copia el
directorio `/opt/osrm/data` ya construido: el servicio solo lo lee.

**Zona de operación.** `BBOX` en `scripts/osrm-local.sh` cubre Querétaro y
alrededores. Fuera de esa caja no hay callejero y el ajuste cae al respaldo,
que dibuja la traza cruda del GPS. Si la flotilla se mueve a otra región,
amplía el `BBOX` y vuelve a ejecutar el script.

**Refresco del callejero.** Queda programado el día 1 de cada mes a las 04:30.
Construye el grafo nuevo aparte y solo lo cambia si termina bien y responde;
si falla, deja el anterior en servicio. Registro en `/var/log/atlyx/osrm.log`.

## Volver atrás

`instalar.sh` no borra nada existente y se puede repetir. El refresco del
callejero guarda el grafo anterior en `/opt/osrm/data.previo`:

```bash
docker compose stop osrm
rm -rf /opt/osrm/data && mv /opt/osrm/data.previo /opt/osrm/data
docker compose up -d osrm
```
