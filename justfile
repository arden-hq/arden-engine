set shell := ["bash", "-uc"]

# List recipes.
default:
    @just --list

# Install dependencies.
install:
    bun install --frozen-lockfile

# Build the libraries, the server and the CLI.
build:
    bun run build:libs
    bun run build:server
    bun run build:cli

# Build and run the server.
server:
    bun run build:server
    bun run --cwd apps/server-ts start

# Run the self-hosted relay (Bun + SQLite). APNs push needs ARDEN_APNS_KEY_PATH, ARDEN_APNS_KEY_ID and ARDEN_APNS_TEAM_ID.
relay port="8787" db="relay.db":
    bun --conditions=arden-source apps/relay/src/bun/main.ts --port {{port}} --db {{db}}

# Typecheck every workspace, lint, check formatting, dead code and import rules.
check:
    bun run typecheck:libs
    bun run typecheck:server
    bun run typecheck:cli
    bun run --cwd apps/relay typecheck
    bun run check:tells
    bun run check:decision-words
    bun run lint
    bun run format:check
    bun run knip
    bun run depcruise
    just test

# Run every test suite.
test:
    bun run test:libs
    bun run test:server
    bun run test:cli
    bun run test:dist
    bun run --cwd apps/relay test

# Register every engine package with `bun link`, so a local app checkout uses this engine.
link:
    for dir in libs/* apps/server-ts; do (cd "$dir" && bun link); done

# Set every package to a new version, commit and tag it; pushing the tag publishes to npm (.github/workflows/release.yml).
release version:
    node tooling/release.mjs version {{version}}
    bun install
    git commit -am "Release {{version}}"
    git tag -a "v{{version}}" -m "Arden engine {{version}}"
    @echo "Push main and v{{version}} to publish."
