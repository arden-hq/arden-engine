#!/bin/sh
# Install the packaged runtime's Linux dependencies: the root (benchmark
# scripts), the server with its libraries, and the headless client the runner drives it with.
set -eu
cd "$(dirname "$0")/.."
bun install --frozen-lockfile --filter arden-engine --filter @arden-hq/server --filter @arden-hq/headless
