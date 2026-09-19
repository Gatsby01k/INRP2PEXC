#!/usr/bin/env bash
# Run the operator-page visual suite inside the canonical environment (docs/VISUAL_BASELINES.md).
#   bash apps/web/visual/docker.sh compare   # compare-only, same as CI
#   bash apps/web/visual/docker.sh update    # intentional baseline update (review the diff before committing)
#
# Unlike the component suite, these captures need a database: pass a reachable PostgreSQL 18 in
# TEST_DATABASE_URL (the container runs with --network host, so 127.0.0.1 is the host's server). The run uses
# `git archive HEAD` — committed state only — so host node_modules and uncommitted edits are never used. On
# `update`, only the screenshots are copied back.
set -euo pipefail

MODE="${1:-compare}"
case "$MODE" in compare | update) ;; *) echo "usage: docker.sh compare|update" >&2; exit 2 ;; esac

IMAGE="mcr.microsoft.com/playwright:v1.56.1-noble" # must equal CANONICAL.image in packages/visual/src/index.ts
ROOT="$(git rev-parse --show-toplevel)"
NODE_VERSION="$(cat "$ROOT/.nvmrc")"
PNPM_VERSION="12.4.2"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
DB="${TEST_DATABASE_URL:-postgres://postgres@127.0.0.1:5432/postgres}"

git -C "$ROOT" archive --format=tar HEAD | docker run --rm -i --platform linux/amd64 --ipc=host --network host \
  -v "$ROOT/apps/web/visual/__screenshots__:/out" \
  -e VISUAL_ENV_IMAGE="$IMAGE" -e VISUAL_GIT_SHA="$SHA" -e MODE="$MODE" \
  -e TEST_DATABASE_URL="$DB" -e NODE_VERSION="$NODE_VERSION" -e PNPM_VERSION="$PNPM_VERSION" \
  "$IMAGE" bash -euo pipefail -c '
    mkdir /work && tar -x -C /work
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" | tar -xz -C /opt
    export PATH="/opt/node-v${NODE_VERSION}-linux-x64/bin:$PATH"
    npm install -g "pnpm@${PNPM_VERSION}" >/dev/null
    cd /work && pnpm install --frozen-lockfile
    pnpm --filter @inrp2p/web build
    if [ "$MODE" = update ]; then
      pnpm --filter @inrp2p/web test:visual:update
      rm -f /out/*.png /out/ENVIRONMENT.json && cp apps/web/visual/__screenshots__/* /out/
    else
      pnpm --filter @inrp2p/web test:visual
    fi
  '
