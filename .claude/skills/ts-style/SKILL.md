---
name: ts-style
description: TypeScript code style rules for this repo (server-ts, libs). Use when writing or refactoring any TypeScript. Distilled from opencode, zod, tRPC, Vercel AI SDK, XState, mastra, codex, Total TypeScript, and Effective TypeScript.
---

# TypeScript style

Rules for all TypeScript in this repo (`apps/server-ts`, `libs/*`). Distilled from the style guides and source of opencode, mastra, and codex, the source of zod v4, tRPC, Vercel AI SDK, and XState v5, and Total TypeScript / Effective TypeScript (2nd ed.). Rules marked **(new code)** set the bar for new designs; do not churn working code to retrofit them without a reason.

## Modeling state and data

Model state as a discriminated union of the valid shapes with one literal tag field — never one interface whose optional fields or boolean flags can contradict each other. When properties co-vary, write a union of interfaces, not an interface of unions.

```ts
// Bad — admits isLoading && error, and fill layout with line paint
interface State { isLoading: boolean; error?: string; data?: string }
interface Layer { type: "fill" | "line"; layout: FillLayout | LineLayout; paint: FillPaint | LinePaint }

// Good — impossible states unrepresentable, tag narrows both fields at once
type State = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; data: string }
type Layer =
  | { type: "fill"; layout: FillLayout; paint: FillPaint }
  | { type: "line"; layout: LineLayout; paint: LinePaint }
```

Error/event variants follow the same shape: each variant is its own interface with a literal `code`/`type` discriminant extending a shared base, exported as the union — never one wide interface with optional fields (zod's `$ZodIssue`, our loop's `AgentEvent`).

```ts
// zod v4 errors.ts — each variant carries only fields that exist for it
interface IssueTooBig extends IssueBase { readonly code: "too_big"; readonly maximum: number }
interface IssueInvalidType extends IssueBase { readonly code: "invalid_type"; readonly expected: string }
export type Issue = IssueTooBig | IssueInvalidType | ...
```

Optional properties are a design smell in canonical types: make fields required and normalize partial/raw input once at the boundary. Push nullability to the perimeter — a group of related values is entirely absent or entirely populated, never a mix of nullable fields.

```ts
// Bad — every consumer re-checks each field, and half-set states exist
interface Hike { miles?: number; km?: number }
let min: number | undefined, max: number | undefined

// Good — defaults applied once at the edge; one check for the whole group
interface Hike { km: number }
const normalizeHike = (raw: RawHike): Hike => ({ km: raw.km ?? raw.miles! * 1.609 })
let extent: [min: number, max: number] | null = null
```

**(new code)** Model absence as `undefined`, not `| null`, inside the codebase; convert external `null` once at the boundary with `?? undefined`. Never fabricate a fallback to satisfy a signature — narrow at the caller so the callee stays strict.

```ts
// Bad — fetches "" when id is absent, a type error became a wrong runtime call
useThread(threadId ?? "")
// Good — caller narrows; useThread(threadId: string) stays strict
if (threadId === undefined) return
useThread(threadId)
```

Signal "not found"/"absent" with `undefined` or a tagged variant, never an in-domain sentinel like `-1`, `0`, or `""` — a sentinel shares the type of real values, so nothing forces callers to handle it (`vals.slice(0, indexOf(v))` is silently wrong on `-1`).

Never use `enum`. Use a literal union, or an `as const` object with a derived union when you need runtime values:

```ts
const Status = { Open: "open", Closed: "closed" } as const
type Status = (typeof Status)[keyof typeof Status] // "open" | "closed"
```

A boolean flag that will ever grow a third state becomes a literal-union field, with a doc comment stating what each value means:

```ts
// zod schemas.ts — undefined is the base state, each rung documented
/** undefined — required; "optional" — may be omitted; "defaulted" — omitted AND substituted. */
optin?: "optional" | "defaulted" | undefined
```

Use `Record<UnionType, V>` (not an index signature or `Partial` map) for lookup tables keyed by a union:

```ts
type Lang = "en" | "de"
const greetings: Record<Lang, string> = { en: "hi", de: "hallo" }
// adding "fr" to Lang → compile error here, not undefined at runtime
```

Constrain payloads that cross a serialization boundary (persistence, IPC, wire, error details) to JSON-safe types; live handles and closures never sit on a serialized shape.

## Exhaustiveness

A literal-to-literal mapping (error-reason translation, label lookup) is an exhaustive `switch`, never an if-chain. On a closed union, omit `default` so the compiler flags new members; group identity cases with fallthrough. If most branches are identity, a doc comment says why the exceptions exist.

```ts
// One real mapping, compiler-checked — adding a StoreError reason breaks this switch
const publicReason = (reason: StoreError["reason"]) => {
  switch (reason) {
    case "conflict":
      return "blocked" as const
    case "not_found":
    case "invalid":
      return reason
  }
}
```

When a `default` arm is genuinely needed on a union switch, make it assert exhaustiveness — never a silent catch-all that swallows future members:

```ts
switch (event.type) {
  case "text": ...
  case "tool": ...
  default: {
    const _exhaustive: never = event
    throw new Error(`unhandled event: ${_exhaustive}`)
  }
}
```

## Types and inference

Avoid `any`. Avoid `as` casts: narrow with type guards, generic type arguments, or `satisfies`; `as const` is always fine. When an unsafe cast is genuinely unavoidable, bury it inside one small function with a precise honest signature — never let assertions leak into calling code, and never cast in tests (fixture casts hide exactly the drift tests exist to catch).

```ts
// Bad — unchecked claims
const meta = msg.metadata as MessageMetadata
const el = document.querySelector("[data-x]") as HTMLElement

// Good — checked narrowing
const el = document.querySelector<HTMLElement>("[data-x]")
if (!el) throw new Error("missing [data-x]")
const meta = isMessageMetadata(msg.metadata) ? msg.metadata : undefined
// and the guard must prove what it claims: a typeof-object check is `isRecord`, not `is MessageMetadata`
```

Rely on inference for locals; annotate explicit return types on exported functions so accidental API changes fail at the function that caused them, not at distant call sites.

Type everything crossing a trust boundary (`JSON.parse`, `fetch().json()`, env, IPC) as `unknown` and narrow with a schema or predicate. A generic parameter must link two positions in a signature; single-use generics are disguised assertions:

```ts
// Bad — caller conjures any type with no check
function parseJSON<T>(json: string): T
// Good — caller must validate or assert visibly
function parseJSON(json: string): unknown
```

Validate config-shaped literals with `satisfies`, not an annotation or cast — conformance is checked, the literal type survives:

```ts
const routes = { home: "/", chat: "/chat/:id" } satisfies Record<string, string>
routes.chat // "/chat/:id", not string
```

Derive secondary types (params objects, option bags, event unions) from the source-of-truth type via `Omit`/`Partial`/`keyof`/mapped types instead of restating fields that will drift:

```ts
// One source of truth: adding an event kind updates union, handlers, payloads together
type EventMap = { open: { id: string }; close: { reason: string } }
type Event = { [K in keyof EventMap]: { type: K } & EventMap[K] }[keyof EventMap]
```

**(new code)** Library-API niceties, where they earn their keep:

```ts
// const T — literal configs survive without as const (zod: literal<const T>(value: T))
function defineTool<const T extends ToolConfig>(config: T): Tool<T>
// (string & {}) — known values autocomplete, arbitrary strings still pass
type ModelId = "gpt-5.2-codex" | "gpt-5" | (string & {})
// NoInfer — this parameter is checked against T, not a source of T
function setDefault<T>(values: T[], fallback: NoInfer<T>): void
// branding — validated primitives can't be swapped for raw strings
type ChatId = string & { readonly __brand: "ChatId" }
```

A non-obvious type-level trick gets a comment naming the failure it works around (XState links the TypeScript issue number above each one).

## Errors

Errors carry closed literal unions for `reason`; translate between vocabularies with exhaustive switches at the boundary (see Exhaustiveness).

Avoid `try`/`catch` where possible; prefer typed error values at boundaries. Normalize every caught `unknown` through one shared helper that passes through real Errors, wraps primitives, and chains the original as `cause` — never re-wrap by string concatenation:

```ts
const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause), { cause })
```

For invariants types can't express, throw at construction/definition time with a message naming the offending element — never defer the failure to first use (zod validates discriminated-union options at the `discriminatedUnion()` call, not on the first parsed input).

Retryability is a typed field derived once from status code / error class, not string-matching at call sites (loop's `isRetryableFailure` is the local precedent).

## API surface

Public functions take a single options object destructured in the signature with inline defaults; no bare boolean or nullable positional parameters that produce opaque call sites:

```ts
// Bad — every call site is a guessing game
renderRow(item, true, undefined)
// Good — self-documenting
renderRow(item, { selected: true })
```

Accept liberal input types but return one strict canonical type; never reuse the loose input type as the return type. Accept shorthand (`string | Options`, `T | readonly T[]`) at the edge and normalize once in one shared function — internals see only the canonical shape:

```ts
declare function setCamera(c: CameraOptions): void            // accept loose
declare function viewportForBounds(b: BoundsLike): Camera     // return strict — NOT CameraOptions
```

Keep each package's public surface minimal and deliberate: private modules by default, a curated entrypoint, no test-only helpers exported from implementation files. Export every type that appears in a public signature — consumers should never need `Parameters<>`/`ReturnType<>` gymnastics.

Inject nondeterminism (clock, id generation, randomness) as defaulted options, never by mutating module state — same rule in tests: never mutate `process.env`; pass config from above:

```ts
// Vercel AI SDK pattern — deterministic in tests, zero cost in prod
function createRun({ now = Date.now, generateId = defaultGenerateId } = {}) { ... }
```

## Functions, variables, control flow

Keep logic in one function unless it is composable or reused. Do not extract a helper with exactly one caller unless it hides a genuinely complex boundary or names a real concept that improves the caller; inline until a second caller exists.

When a function has several validation branches, the main function reads as the happy path with supporting helpers **below** it:

```ts
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}
// requireConfig / readMetadata defined below, close to their caller
```

Prefer `const` + ternary or early return over `let` reassignment; never build a value through a mutable ladder of conditionals — extract a named function that returns it. Inline a value used only once:

```ts
// Bad
let foo
if (condition) foo = 1
else foo = 2
const journalPath = path.join(dir, "journal.json")
const journal = await readJson(journalPath)

// Good
const foo = condition ? 1 : 2
const journal = await readJson(path.join(dir, "journal.json"))
```

Prefer early returns over `else` (lint `no-else-return`). No nested ternaries (lint `no-nested-ternary`). Prefer functional array methods (`flatMap`, `filter`, `map`) with type guards on `filter`. Avoid unnecessary destructuring — `config.timeout` preserves context that `timeout` loses.

Never alias or star-import; import a module's own exported namespace by name if you need one. Dynamic-import heavy modules only in the branch that needs them, bound at the top of that scope — never inline `(await import("./m")).value()` chains.

## Structure

- Co-locate a type with the code that uses it; promote to a shared file only at the smallest scope that actually imports it. A global `types.ts` dumping ground is forbidden.
- Cap modules around ~500 lines (hard stop ~800, tests excluded): past that, new functionality goes in a new module, and extractions take their tests along. Keep high-traffic orchestration files orchestration-only.
- Resist adding concepts to the biggest package (`apps/server-ts`) by default — check whether an existing lib fits or a new one is due; that pressure is why `@arden-hq/loop`, `@arden-hq/jobs`, `@arden-hq/journal` exist.
- Comment non-obvious constraints and surprising behavior only — never what the next line does or why a change is correct.

## Testing

Avoid mocks; never patch `globalThis.*` unless it is the only option. Test the actual implementation — do not duplicate logic into tests.

Assert deep equality on whole objects, not field-by-field — extra or changed fields should fail. Never write tests that re-assert statically defined constants:

```ts
// Bad — a new `error` field slips through unasserted
expect(r.id).toBe("a"); expect(r.status).toBe("done")
// Good
expect(r).toEqual({ id: "a", status: "done" })
```

Few, critical tests over broad shallow suites (the Loop suite is the precedent: cancellation, parallel tools, streaming, retries, state). Run from the package dir: `bun run test` in `apps/server-ts` / `libs/loop`.

## Repo specifics

- Format with the root oxfmt config (`.oxfmtrc.jsonc`, `bun run format`) (no semicolons, double quotes, width 100, no trailing commas); `bun run lint` before committing.
- Typecheck/build via the workspace scripts: `bun run typecheck` (`tsc -p <config> --noEmit`) / `bun run build` (`tsc -b`), all on the catalog's TS 7. Never a globally installed `tsc`. The server alone runs `node_modules/@typescript/native/bin/tsc`, because its `typescript` stays 6.x for a test that uses the TS JS API; the root keeps 6.x as the dependency-cruiser peer.
- Workspace libs resolve to `src` through the `arden-source` export condition wherever code is checked or tested (`tsconfig.check.json`/`tsconfig.test.json` `customConditions`, the root `vitest.config.mjs`, Desktop's Vite config; Desktop's `tsconfig.json` `paths` for tsc and `bun test`). Only runtimes (server `dist`, Electron main) and dist tests (`bun run test:dist`) read `dist`, so no reinstall or rebuild is needed to see a lib edit. `build` never cleans; `bun run clean` does.
- `libs/loop` is plain TypeScript — no Effect, single runtime dependency (`eventsource-parser`); a boundary test enforces this. The server keeps Effect; in Effect generators, bind services to named variables — no nested `yield* (yield* Foo.Service).bar()`.
- Full mined source material (99 rules with examples and citations) lives in `references/mined-rules.md` next to this file for deeper API-design questions.
