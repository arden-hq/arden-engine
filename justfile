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
    just speed

# Run every test suite.
test:
    bun run test:libs
    bun run test:server
    bun run test:cli
    bun run test:dist
    bun run --cwd apps/relay test

# Seed a database at the owner's size and at four times the history, open every screen and run every timer job on both, and fail on a statement that gets slower as the history grows. Takes minutes.
speed:
    cd apps/server-ts && ARDEN_SQL_SPEED=1 bunx vitest run --project speed

# Copy the owner's database and Memory folder into <into> for replays, reading the source only. Refuses under 10 GB free. Tests find the copy through ARDEN_REPLAY_COPY=<into>.
replay-copy into *flags:
    node --conditions=arden-source apps/server-ts/scripts/replay-copy.ts --into {{into}} {{flags}}

# Count, on the replay copy in <copy> and with no model, the Memory Capture runs a catch-up of the old unread turns would take, and the typed owner turns, before and since 28 Aug 2026.
capture-backlog copy:
    cd apps/server-ts && ARDEN_CAPTURE_BACKLOG=1 ARDEN_REPLAY_COPY={{copy}} bunx vitest run --project capture-backlog

# Score, on the replay copy in <copy> and with no model, whether a new chat is sent the Memory pages that answer each question in the private <questions> file. Results go beside <questions>.
memory-test-sent questions copy:
    cd apps/server-ts && ARDEN_MEMORY_TEST=sent ARDEN_MEMORY_TEST_QUESTIONS={{questions}} ARDEN_REPLAY_COPY={{copy}} bunx vitest run --project memory-test

# Print the plan and cost of the paid "answered" memory test for <questions> on the replay copy in <copy>, from first turns measured there. Sends nothing to a model; the paid run is not built.
memory-test-answered questions copy *flags:
    cd apps/server-ts && ARDEN_MEMORY_TEST=answered ARDEN_MEMORY_TEST_FLAGS="{{flags}}" ARDEN_MEMORY_TEST_QUESTIONS={{questions}} ARDEN_REPLAY_COPY={{copy}} bunx vitest run --project memory-test

# Run, on the replay copy in <copy>, the check the server runs each minute for Memory files changed outside Arden, and print by page path what it took in, what it set aside and why, the files not in Memory, and each page's last outside change. Prints no page text.
memory-outside-edits copy:
    cd apps/server-ts && ARDEN_OUTSIDE_EDITS=1 ARDEN_REPLAY_COPY={{copy}} bunx vitest run --project outside-edits

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
