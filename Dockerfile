FROM node:22-alpine AS base

# Build dependencies for better-sqlite3 and sharp
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY public/ ./public/

RUN mkdir -p /data/projects /data/thumbnails

ENV NODE_ENV=production
ENV PORT=8081
ENV STREETVIEW_DATA_DIR=/data

# TETO DE HEAP, casado com o `memory: 512M` do docker-compose.yml. Sem ele o V8
# so coleta sob pressao propria, ignora o limite do cgroup e o container morre
# por OOM em vez de coletar. Medido martelando o pior tile do acervo (5.907
# pontos) com 8 pedidos simultaneos: sem teto o RSS chegou a 373,5 MB e seguia
# subindo; com 320 ficou em 300,4 MB depois do dobro da carga.
ENV NODE_OPTIONS=--max-old-space-size=320

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:8081/health || exit 1

CMD ["node", "src/server.js"]
