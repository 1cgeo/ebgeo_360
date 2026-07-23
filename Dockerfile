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

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:8081/health || exit 1

CMD ["node", "src/server.js"]
