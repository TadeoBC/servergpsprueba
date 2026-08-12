# Node 20 LTS sobre Alpine: imagen chica y suficiente para este servicio.
FROM node:20-alpine

# tini reparte bien las señales: sin él, SIGTERM no llega a node y el apagado
# ordenado (cerrar sockets y el pool de postgres) no ocurre.
RUN apk add --no-cache tini curl

WORKDIR /app

# Las dependencias se copian primero para aprovechar la caché de capas: si solo
# cambia el código, npm ci no se vuelve a ejecutar.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# No corre como root.
RUN addgroup -S atlyx && adduser -S atlyx -G atlyx && chown -R atlyx:atlyx /app
USER atlyx

ENV NODE_ENV=production

# 5023 ingesta de rastreadores · 8080 API/web (solo lo alcanza Caddy)
EXPOSE 5023 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
