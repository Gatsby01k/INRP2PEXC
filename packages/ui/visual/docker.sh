#!/usr/bin/env bash
# Run the visual suite inside the canonical environment (docs/VISUAL_BASELINES.md).
#   bash packages/ui/visual/docker.sh compare   # compare-only, same as CI
#   bash packages/ui/visual/docker.sh update    # intentional baseline update (review the diff before committing)
#
# The suite runs on `git archive HEAD` (committed state only) streamed into the container, so host node_modules
# (e.g. macOS binaries) and uncommitted edits are never used. On `update`, only the screenshots are copied back.
set -euo pipefail

MODE="${1:-compare}"
case "$MODE" in compare | update) ;; *) echo "usage: docker.sh compare|update" >&2; exit 2 ;; esac

IMAGE="mcr.microsoft.com/playwright:v1.56.1-noble" # must equal CANONICAL.image in visual/environment.ts
NODE_VERSION="$(cat "$(git rev-parse --show-toplevel)/.nvmrc")"
PNPM_VERSION="12.4.2"
ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"

git -C "$ROOT" archive --format=tar HEAD | docker run --rm -i --platform linux/amd64 --ipc=host \
  -v "$ROOT/packages/ui/visual/__screenshots__:/out" \
  -e VISUAL_ENV_IMAGE="$IMAGE" -e VISUAL_GIT_SHA="$SHA" -e MODE="$MODE" \
  -e NODE_VERSION="$NODE_VERSION" -e PNPM_VERSION="$PNPM_VERSION" \
  "$IMAGE" bash -euo pipefail -c '
    mkdir /work && tar -x -C /work
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" | tar -xz -C /opt
    export PATH="/opt/node-v${NODE_VERSION}-linux-x64/bin:$PATH"
    npm install -g "pnpm@${PNPM_VERSION}" >/dev/null
    cd /work && pnpm install --frozen-lockfile
    pnpm --filter @inrp2p/ui build-storybook
    if [ "$MODE" = update ]; then
      UPDATE_VISUALS=1 pnpm --filter @inrp2p/ui test:visual:update
      rm -f /out/*.png /out/ENVIRONMENT.json && cp packages/ui/visual/__screenshots__/* /out/
    else
      pnpm --filter @inrp2p/ui test:visual
    fi
  '
