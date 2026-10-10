# syntax=docker/dockerfile:1.7
#
# INRP2P Exchange — container images (production task E3). One build, three targets from the same sources and lockfile:
#
#   docker build -f deploy/Dockerfile --target web     -t inrp2p-web:$SHA     --build-arg RELEASE=$SHA .
#   docker build -f deploy/Dockerfile --target worker  -t inrp2p-worker:$SHA  --build-arg RELEASE=$SHA .
#   docker build -f deploy/Dockerfile --target migrate -t inrp2p-migrate:$SHA --build-arg RELEASE=$SHA .
#
# The pinned toolchain (Node 24.21.0, pnpm 12.4.2) is the repository's own (.nvmrc, packageManager); the install is the
# frozen lockfile; the processes run as the unprivileged `node` user. No secret is baked into any layer: configuration
# arrives as environment variables from the platform's secret manager at run time (docs/DEPLOYMENT.md). PDF printing
# needs a browser, so it has its own target (`worker-pdf`) rather than a browser in every image.

ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=true
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
WORKDIR /srv/inrp2p

FROM toolchain AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @inrp2p/web build

# Production dependencies only, from the same lockfile; workspace packages are TypeScript run by Node's type stripping.
FROM toolchain AS runtime-base
COPY --from=build /srv/inrp2p /srv/inrp2p
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && rm -rf /root/.cache /root/.local/share/pnpm
ARG RELEASE=unknown
ENV NODE_ENV=production INRP2P_RELEASE=${RELEASE}
USER node

FROM runtime-base AS web
WORKDIR /srv/inrp2p/apps/web
EXPOSE 3000
# Next.js handles SIGTERM: it stops accepting connections and lets requests in flight finish.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]

FROM runtime-base AS worker
WORKDIR /srv/inrp2p/apps/worker
# graphile-worker handles SIGTERM: it stops taking jobs, lets running ones finish, then the pool is closed.
CMD ["node", "src/main.ts"]

FROM worker AS worker-pdf
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core && rm -rf /var/lib/apt/lists/*
ENV INRP2P_PDF_RENDERER=chromium INRP2P_CHROMIUM_PATH=/usr/bin/chromium
USER node

# One-shot: explicit SQL migrations under an advisory lock, then the queue schema. Run before web and worker roll. The
# migration entry is a root script, so it keeps the build's full install (a short-lived job, never serving traffic).
FROM toolchain AS migrate
COPY --from=build /srv/inrp2p /srv/inrp2p
ARG RELEASE=unknown
ENV NODE_ENV=production INRP2P_RELEASE=${RELEASE}
USER node
CMD ["node", "scripts/migrate.ts"]
