# `@arden-hq/relay`

The relay connects a Mac and its phones. It passes sealed frames between them. It cannot read app messages, because the Mac and the phone encrypt them end to end. The wire format is in `@arden-hq/relay-protocol`.

The relay has three jobs:

- It pairs a phone with a Mac.
- It holds messages for a device that is offline.
- It sends an Apple push notification (APNs) when a phone must wake up.

## Two hosts, one core

| Path | What it is |
| --- | --- |
| `src/core/` | The relay logic and its storage interface. Both hosts share it |
| `src/bun/` | Self-hosted server on Bun with SQLite |
| `src/cloudflare/` | Cloudflare Worker with a Durable Object (`wrangler.toml`) |
| `src/apns/` | The APNs client |

## Run it yourself

```bash
just relay                       # from the repository root: port 8787, db relay.db
just relay 9000 /data/relay.db   # another port and database
```

Phones and Macs connect to `/v1/connect`. Push is off until you set `ARDEN_APNS_KEY_PATH`, `ARDEN_APNS_KEY_ID` and `ARDEN_APNS_TEAM_ID`.

To deploy to Cloudflare, build the libraries with `bun run build:libs`, then run `wrangler deploy`. Set the secrets `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID` with `wrangler secret put`. Never commit them.

`scripts/send-test-push.ts` sends one test push.

## Rules

- The relay never holds a session key or a plain-text message.
- Keep the logic in `src/core/`. A host file only connects the core to a runtime and a store.
- A change to the wire format starts in `@arden-hq/relay-protocol`.

## Check

```bash
bun run --cwd apps/relay typecheck
bun run --cwd apps/relay test
```
