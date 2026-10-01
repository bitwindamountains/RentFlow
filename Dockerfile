# syntax=docker/dockerfile:1.7
# One Dockerfile, three targets:
#   api      – production API (non-root, prod dependencies only)
#   migrate  – runs `prisma migrate deploy` once per release
#   web      – Caddy serving the PWA and proxying /api to the API
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS api-build
COPY apps/api apps/api
RUN npm run db:generate --workspace api && npm run build --workspace api

FROM api-build AS migrate
WORKDIR /app/apps/api
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION} AS api-prod-deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace api --include-workspace-root=false --no-audit --no-fund

FROM node:${NODE_VERSION} AS api
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-prod-deps /app/node_modules ./node_modules
COPY --from=api-build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma
# Uploaded documents (STORAGE_DRIVER=local). Mount a volume here; a new named volume inherits this ownership.
RUN mkdir -p /data/uploads && chown node:node /data/uploads && chmod 700 /data/uploads
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/v1/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM deps AS web-build
COPY apps/web apps/web
RUN npm run build --workspace web

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist/web/browser /srv
EXPOSE 80 443
