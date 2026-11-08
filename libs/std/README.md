# `@arden-hq/std`

Small helpers that all Arden packages share. Each subpath holds one behavior. The package has no dependencies and no Effect. Every other workspace may import it.

Import by subpath, for example `import { sleep } from "@arden-hq/std/sleep"`. There is no root entry.

| Subpath | What it gives you |
| --- | --- |
| `atomic-file` | `writeAtomic`, `writeAtomicSync` |
| `publish` | `publishNoReplace`, which writes a file only if none exists |
| `attempt` | `attempt`, which turns a throw into a rejected promise |
| `count` | counts, byte sizes and word lists for display |
| `errors` | `toError`, `errorMessage`, `redactedFailureText` |
| `hash` | SHA-256 as hex, base64url or bytes, and `hashFile` |
| `json` | `isRecord`, `canonicalJson`, `sameJson` |
| `paths` | `isWithin`, `expandHome`, `collapseHome`, `resolveArdenDir` |
| `process` | `signalProcessGroup`, `terminate` |
| `retry` | `retryableStatus`, backoff delays, `Retry-After` parsing |
| `sleep` | `sleep(ms, signal?)` |
| `slug` | `slugify`, `uniqueName` |
| `text` | `cutText`, `clipLine`, `foldSpace`, `escapeRegExp` |
| `time` | durations and relative time labels |
| `url` | server and web URL checks, `isLoopbackHost` |

## Rules

- Add a helper here only when two or more packages need it.
- A helper must not know about Arden's product. Keep it plain.
- One behavior has one implementation. Do not copy a helper into another package.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
