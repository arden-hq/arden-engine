
## XState v5 — packages/core/src (statelyai/xstate, shallow clone)
- [api-design] Register named implementations once in a setup()-style factory that captures them as type parameters; downstream config then references them by string keys typed via mapped `keyof` types, so strings stay checked without re-declaring generics at every call site.
  WHY: Kills the v4-style pain of stringly-typed references and repeated generic annotations: a typo in an action/actor name is a compile error, and consumers write zero explicit type arguments.
  EX: setup.ts:369-485 — `setup({ actions, guards, ... })` returns `createMachine` whose config is typed against `ToParameterizedObject<TActions>`; config keys like `actions: 'doSomething'` are validated by `[K in keyof TActions]` mapped types.
- [types] Model lifecycle status as a discriminated union of interfaces where fields absent in a variant are typed explicitly as `undefined`, not marked optional or omitted.
  WHY: Narrowing on the discriminant then yields exact field types (`status === 'done'` gives `output: TOutput`, `error: undefined`) and enables extraction tricks like `(TSnapshot & { status: 'done' })['output']` — optional fields would leave everything `T | undefined` everywhere.
  EX: State.ts:163-235 — `ActiveMachineSnapshot { status: 'active'; output: undefined; error: undefined }` vs `DoneMachineSnapshot { status: 'done'; output: TOutput; error: undefined }`; used by `OutputFrom` in types.ts:167.
- [api-design] Ship `XFrom<T>` extractor types (InputFrom, OutputFrom, SnapshotFrom) so consumers derive types from values they already hold instead of restating generic parameters.
  WHY: Keeps consumer code decoupled from your generic arity — you can add type parameters without breaking callers, and users never hand-copy a 14-generic instantiation.
  EX: types.ts:139-178 — `type InputFrom<T> = T extends StateMachine<..., infer TInput, ...> ? TInput : ...`; consumer writes `SnapshotFrom<typeof machine>`.
- [errors] Where a broad union reaches a callback that only handles some members, provide an `asserts x is Extract<...>` assertion helper that both narrows the type and throws a descriptive runtime error on mismatch.
  WHY: Gives type-safe access to variant fields in contexts where control flow can't prove the discriminant, without unchecked casts that silently lie at runtime.
  EX: assert.ts:27-49 — `function assertEvent<TEvent, TDesc>(event, type): asserts event is ExtractEvent<TEvent, TDesc>` throws `Expected event {...} to have type matching "greet"`.
- [types] For handler maps keyed by a union, use a mapped type over the key union and re-narrow the payload per key (`[K in Descriptor<TEvent>]?: Handler<Extract<TEvent, K>>`) so each handler's argument is the exact variant, never the whole union.
  WHY: Handlers get precise payload types for free and adding a union member automatically types its new handler slot — no manual switch-narrowing inside handlers.
  EX: types.ts:580-590 — `{ [K in EventDescriptor<TEvent>]?: TransitionConfigOrTarget<TContext, ExtractEvent<TEvent, K>, ...> }`.
- [types] Encode hierarchical string keys with recursive template-literal types when you support wildcard/prefix matching, and normalize the descriptor back to a `${prefix}.${string}` pattern for matching.
  WHY: Makes wildcard keys like 'user.*' autocomplete and typo-check against the actual event union instead of being accepted as arbitrary strings.
  EX: types.ts:593-606 — `type PartialEventDescriptor<T> = T extends `${infer L}.${infer R}` ? `${L}.*` | `${L}.${PartialEventDescriptor<R>}` : never` plus `NormalizeDescriptor`.
- [types] Test for `never` with the tuple trick `[T] extends [never]` (an `IsNever<T>` helper), never with bare `T extends never`.
  WHY: Bare conditional distributes over the union and `never extends never` vacuously yields `never`, so the check silently returns the wrong branch.
  EX: types.ts:56 — `export type IsNever<T> = [T] extends [never] ? true : false;` used in setup.ts:59 to switch actor-id typing.
- [types] In unions that may contain function members, use `{} | null | undefined` (a named NonReducibleUnknown alias) instead of `unknown`, because `T | unknown` collapses to `unknown` and destroys contextual typing of callback parameters.
  WHY: Prevents silent implicit-any on callback args passed where `((x: number) => void) | unknown` was intended.
  EX: types.ts:34-50 — `export type NonReducibleUnknown = {} | null | undefined;` with the JSDoc counterexample `test((arg) => {}) // oops, implicit any`.
- [types] When a function type must carry type parameters that don't appear in its signature (for later inference), attach them as optional phantom fields (`_out_TFoo?: TFoo`) rather than widening the signature or casting.
  WHY: Callback positions are contravariant, so extra type info is otherwise uninferable; phantom fields let helper types read it back (`'_out_TGuard' extends keyof T ? T['_out_TGuard'] : ...`) with zero runtime cost.
  EX: types.ts:190-198 — `ActionFunction = { (args, params): void; _out_TActor?: TActor; _out_TGuard?: TGuard; ... }`, consumed in guards.ts:31.
- [types] To infer structure from a config object literal, take it as a `const TConfig extends Config<...>` type parameter, return the literal type, and derive downstream types (state values, children ids) from it with helper conditional types, using a `Cast<A, B>` helper where the compiler can't prove the bound.
  WHY: Users get literal-precise derived types (e.g. `snapshot.matches('green')` typo-checked) from a plain object with no `as const` or duplicate declarations.
  EX: setup.ts:268-312 — `createMachine: <const TConfig extends MachineConfig<...>>(config) => StateMachine<..., ToStateValue<TConfig>, ...>` with `Cast<ExtractConfigChildren<TConfig>, Record<string, string>>`.
- [types] When inferring types from large literal configs, run the inferred type through a trimming mapped type that keeps only the keys later code reads, instead of propagating the full literal.
  WHY: Bounds compile time and declaration-emit size — huge inferred config types otherwise serialize into enormous .d.ts output and slow every dependent file.
  EX: setup.ts:67-77 — `ToStateSchema<TSchema>` keeps only `'id' | 'states'`: "this helps with type serialization as it makes the inferred type much shorter when dealing with huge configs".
- [types] Every non-obvious type-level trick gets a comment stating the failure it works around, ideally with a link to the TypeScript issue/PR that motivates it.
  WHY: Type tricks look like noise to the next editor and get 'simplified' into the exact bug they prevented; the issue link makes the constraint checkable when TS versions change.
  EX: types.ts:55 links microsoft/TypeScript#23182 above IsNever; types.ts:78-82 explains why native `NoInfer` can't replace `DoNotInfer` with two PR links.
- [api-design] Accept `T | readonly T[]` only at the public API edge and normalize with `toArray` in the first line; all internal code operates on the array shape.
  WHY: Keeps caller ergonomics without forking internal logic into single-vs-array branches that drift apart.
  EX: assert.ts:34 — `const types = toArray(type);` immediately after the `TAssertedDescriptor | readonly TAssertedDescriptor[]` parameter.
- [errors] When a library must surface an error thrown by user code without corrupting its own in-progress work, rethrow it in a fresh macrotask (`setTimeout(() => { throw err })`) instead of throwing through library frames or swallowing it.
  WHY: Global error handlers and bug trackers still see the exception, but the library's own execution (queue processing, state commit) completes consistently.
  EX: reportUnhandledError.ts:9-13 — `export function reportUnhandledError(err: unknown) { setTimeout(() => { throw err; }); }`.
- [structure] Gate expensive validation and rich error messages behind a build-time-resolvable dev flag imported from a dedicated module, so production bundles tree-shake the checks away.
  WHY: Lets you afford thorough misuse diagnostics (negative timeouts, config mistakes) without paying bundle size or runtime cost in production.
  EX: waitFor.ts:1,55 — `import isDevelopment from '#is-development'; ... if (isDevelopment && resolvedOptions.timeout < 0) { console.error(...) }` (subpath-condition module resolving to `true.ts`/`false.ts`).

## Effective TypeScript, 2nd ed. (Dan Vanderkam) — item list from github.com/danvk/effective-typescript; examples from effectivetypescript.com posts (special-values, null-values-to-perimeter) and the book's canonical item examples
- [types] Model state as a tagged union of the valid shapes, never as one interface with flags/optionals whose combinations can contradict each other (Item 29).
  WHY: Impossible states (isLoading && error) become unrepresentable, so branches that would silently mishandle them fail to compile instead.
  EX: // bad
interface State { isLoading: boolean; error?: string; data?: string }
// good
type State =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ok'; data: string }
- [types] When properties co-vary, write a union of interfaces, not an interface of unions (Item 34).
  WHY: An interface of unions admits mismatched combinations (fill layout + line paint) that the union of interfaces rules out and lets the tag narrow.
  EX: // bad
interface Layer { type: 'fill' | 'line'; layout: FillLayout | LineLayout; paint: FillPaint | LinePaint }
// good
type Layer =
  | { type: 'fill'; layout: FillLayout; paint: FillPaint }
  | { type: 'line'; layout: LineLayout; paint: LinePaint }
- [types] Every switch over a discriminated union ends with a default branch that assigns the value to never (assertNever), so widening the union breaks the build at each handler (Item 59).
  WHY: Adding a union member without this yields silently unhandled cases at runtime instead of a compile error listing every site to update.
  EX: function assertNever(x: never): never { throw new Error(`unexpected: ${x}`) }
switch (s.kind) {
  case 'loading': ...
  case 'ok': ...
  default: return assertNever(s);
}
- [errors] Signal 'not found' / 'absent' with null or a tagged variant, never with an in-domain sentinel like -1, 0, or '' (Item 36).
  WHY: A sentinel shares the type of real values, so the compiler cannot force callers to handle the failure case and wrong results flow silently (vals.slice(0, -1)).
  EX: // bad: indexOf returns -1, slice(0,-1) silently wrong
// good
function safeIndexOf<T>(vals: readonly T[], v: T): number | null {
  const i = vals.indexOf(v);
  return i === -1 ? null : i;
} // callers MUST check null before slicing
- [types] Push null/undefined to the perimeter of a structure: a group of related values is entirely null or entirely populated, never a mix of nullable fields (Item 33).
  WHY: Mixed nullability forces a non-null check per field and invites states where half the group is set; one nullable wrapper needs one check.
  EX: // bad: let min, max;  // each independently undefined
// good
let extent: [number, number] | null = null;
if (!extent) extent = [n, n];
else extent = [Math.min(n, extent[0]), Math.max(n, extent[1])];
- [api-design] Prefer unions of literal types (or keyof T) to string-typed fields and parameters (Item 35).
  WHY: 'stringly typed' APIs accept typos and kill inference; literal unions catch them at the call site and let return types flow (T[K]).
  EX: // bad: recordingType: string, pluck(records, key: string): any[]
// good
type RecordingType = 'studio' | 'live';
function pluck<T, K extends keyof T>(records: T[], key: K): T[K][]
- [types] Treat an optional property as a design smell: make fields required in the canonical type and normalize partial/raw input at the boundary into it (Item 37).
  WHY: Optionals never become required again, multiply the state space, and push defaulting logic to every consumer instead of one normalize step.
  EX: // bad: interface Hike { miles?: number; km?: number }
// good
interface Hike { km: number }
function normalizeHike(raw: RawHike): Hike { ... } // defaults applied once, at the edge
- [api-design] Public functions accept liberal types (Like/Partial variants, unions) but return one strict canonical type — never reuse the loose input type as a return type (Item 30).
  WHY: A loose return type (all fields optional/union) forces every caller to re-narrow what the function already knew.
  EX: declare function setCamera(c: CameraOptions): void;           // accept loose
declare function viewportForBounds(b: LngLatBoundsLike): Camera; // return strict — NOT CameraOptions
- [api-design] A generic type parameter must appear at least twice in a signature; a single-use one is a disguised type assertion — return unknown instead (Item 51).
  WHY: parse<T>(s: string): T lets callers conjure any type with no check; unknown forces them to validate or assert visibly at the call site.
  EX: // bad
function parseJSON<T>(json: string): T
// good
function parseJSON(json: string): unknown // caller narrows/validates
- [errors] When an unsafe cast is genuinely needed, bury the as inside one small function with a precise, honest signature; never let assertions leak into calling code (Item 45).
  WHY: Callers get a fully typed surface and the unsoundness is confined to one audited spot instead of scattered as-casts.
  EX: export function cacheLast<T extends Function>(fn: T): T {
  let last: any;
  // ...memo logic...
  return ((...args: any[]) => { ... }) as unknown as T; // assertion hidden here, signature stays safe
}
- [testing] Write assertion tests for nontrivial types (conditional/mapped/inferred APIs) using expect-type style checks, not 'assign to a typed variable' (Item 55; eslint-plugin-expect-type post).
  WHY: Assignability-based checks pass on any/supertypes, so type regressions ship silently; exact-type assertions fail the build.
  EX: // bad: const x: number[] = map(['a'], () => 1); // passes even if map returns any
// good: expectTypeOf(map(['a'], () => 1)).toEqualTypeOf<number[]>()
- [types] Use Record<UnionType, V> (not an index signature or partial map) for lookup tables keyed by a union, so extending the union forces every table to be updated (Item 61).
  WHY: With {[k: string]: V} or Partial, a new union member compiles with a missing entry and fails at runtime.
  EX: type Lang = 'en' | 'de';
const greetings: Record<Lang, string> = { en: 'hi', de: 'hallo' };
// adding 'fr' to Lang → compile error here, not undefined at runtime
- [types] Let a local mutable value use an evolving type (let out = []; out.push(...)) instead of annotating a premature union, but never let an evolving/implicit-any value escape the function (Item 25).
  WHY: In-function evolution keeps code clean; escaping before the type settles exports any and defeats checking downstream.
  EX: const out = []; // any[]
for (const line of lines) out.push(parse(line)); // now ParsedLine[]
return out; // fine — settled; do NOT pass `out` to helpers before pushing
- [api-design] Export every type that appears in a library's public signatures — parameter and return types included — even if it feels internal (Item 67).
  WHY: Unexported signature types force consumers into Parameters<>/ReturnType<> extraction gymnastics to name what your API already made public.
  EX: // bad: interface SecretSauce {...} (unexported) + export function getGift(name: SecretName): SecretSauce
// good: export interface SecretSauce {...} — it's already extractable via ReturnType anyway

## tRPC (github.com/trpc/trpc) — packages/server/src + packages/client/src, shallow clone @ main 2026-08-22
- [types] For chainable builders, declare the public API as an interface whose methods return a re-parameterized instance of the same interface carrying type state, and back it with ONE any-typed runtime implementation instead of typing the implementation.
  WHY: Trying to make the runtime body satisfy the inference-heavy signature forces casts everywhere and slows the compiler; splitting lets the interface do all inference while the impl stays trivial.
  EX: packages/server/src/unstable-core-do-not-import/procedureBuilder.ts — `interface ProcedureBuilder<TContext, TMeta, TContextOverrides, TInputIn, TInputOut, ...>` with `input(): ProcedureBuilder<..., IntersectIfDefined<TInputIn, inferParser<$Parser>['in']>, ...>`, while `createBuilder` returns a single `AnyProcedureBuilder` object literal.
- [types] Represent 'not yet configured' generic slots with a branded sentinel type (e.g. `type UnsetMarker = 'unsetMarker' & { __brand: 'unsetMarker' }`), and resolve it at use sites with helpers like `DefaultValue<TValue, TFallback> = TValue extends UnsetMarker ? TFallback : TValue` — never with `undefined | T` in the generic.
  WHY: `undefined` is a legitimate user value, so using it as the unset signal makes 'user chose undefined' indistinguishable from 'never set' and breaks conditional resolution.
  EX: procedureBuilder.ts: `query<$Output>(...): QueryProcedure<{ input: DefaultValue<TInputIn, void>; output: DefaultValue<TOutputOut, $Output> }>` — falls back to void/inferred only when the slot was never set.
- [api-design] Reject invalid API usage at compile time by making the offending parameter's type resolve to a branded message type — `type TypeError<TMessage extends string> = TMessage & { _: typeof errorSymbol }` — instead of accepting it and throwing at runtime.
  WHY: The user sees the actual constraint violation as a readable string in the compiler error at the call site, rather than a wall of unmatched generics or a production crash.
  EX: procedureBuilder.ts input(): `schema: undefined extends TInputOut ? $Parser : TypeError<'Cannot chain an optional parser to a required parser'>`; also `TypeError<'Subscription output could not be inferred'>`.
- [api-design] Wrap types at public API boundaries in `Simplify<T>` (mapped-type flatten) so hovers and errors show a plain object literal, keeping raw intersections and helper types internal-only.
  WHY: Consumers debugging from tooltips see `{ user: User; org: Org }` instead of `Overwrite<Context, Overrides1 & Overrides2>`, which is the difference between a usable and unusable library error.
  EX: procedureBuilder.ts: `ctx: Simplify<Overwrite<TContext, TContextOverridesIn>>` in ProcedureResolverOptions; Simplify defined once in types.ts with Date/array escape hatch.
- [api-design] Expose type extraction to consumers only through exported `inferX<T>` helper types (lowercase `infer` prefix), so users never destructure internal generic structure themselves.
  WHY: Internal generic arity/order can change freely as long as the infer-helpers keep working, and the naming convention makes the inference surface discoverable.
  EX: `inferRouterInputs`, `inferProcedureOutput`, `inferProcedureBuilderResolverOptions<typeof authedProcedure>` (router.ts, procedureBuilder.ts) — the last exists solely so users can type shared helper functions over a middleware-narrowed builder.
- [types] Integrate with third-party libraries via minimal structural 'Esque' types describing only the shape you consume, unioned into one accepted type, with a single conditional-type chain to extract in/out types — never by importing the library's types.
  WHY: Zero dependencies on any validator library, and any future library matching the shape works without a code change.
  EX: parser.ts: `type ParserZodEsque<TIn, TOut> = { _input: TIn; _output: TOut }`, `type Parser = ParserWithInputOutput<any,any> | ParserWithoutInput<any>`, `inferParser<TParser>` resolves `{ in; out }` per branch; runtime `getParseFn` duck-types the same shapes.
- [errors] Normalize every caught `unknown` at the boundary through a `getXFromUnknown(cause)` helper that passes through existing instances, wraps primitives, builds a synthetic Error from plain objects, and preserves `cause` and the original `stack` — raw unknowns never propagate.
  WHY: Downstream code can rely on one error type with intact stack/cause chains, instead of every handler re-implementing instanceof/typeof triage.
  EX: error/TRPCError.ts: `getTRPCErrorFromUnknown` returns the TRPCError as-is, else wraps in `new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause })` and copies `cause.stack`; `getCauseFromUnknown` handles primitive/object/function cases.
- [errors] In Error subclasses meant to cross module/realm boundaries: set `this.name` explicitly, call `Object.setPrototypeOf(this, X.prototype)` in the constructor, and make type guards accept `instanceof` OR a name check (`cause instanceof Error && cause.name === 'TRPCError'`).
  WHY: Duplicate package instances and cross-realm objects fail `instanceof`, silently routing known errors down the 'unknown error' path.
  EX: TRPCError.ts:47 name-based fallback; client/TRPCClientError.ts:84 `Object.setPrototypeOf(this, TRPCClientError.prototype)` plus exported `isTRPCClientError` guard.
- [types] Mirror every type-level brand with a runtime marker property plus a tiny named type guard (`isRouter`, `isLazy`), and tag object kinds with literal discriminants like `procedure: true` / `router: true` on the def object.
  WHY: Values that flow through `unknown`/proxy layers can be re-narrowed safely at runtime, matching what the type system claims.
  EX: router.ts: `const lazyMarker = 'lazyMarker' as 'lazyMarker' & { __brand: ... }`, `type Lazy<T> = (() => Promise<T>) & { [lazyMarker]: true }`, `function isLazy(input): input is Lazy<T> { return typeof input === 'function' && lazyMarker in input }`.
- [testing] Write compile-time behavior tests with `expectTypeOf` colocated in the same .test.ts files as runtime tests — asserting narrowing, inference fallbacks, and error-branded types as first-class test cases.
  WHY: Inference is the product in a typed API; without type assertions in CI, a refactor can silently degrade `ctx.user` from `User` back to `User | null` while all runtime tests stay green.
  EX: procedureBuilder.test.ts: after an auth middleware, `expectTypeOf(opts.ctx.user).toEqualTypeOf<User>()` and `expectTypeOf(opts.input).toEqualTypeOf<unknown>()` inside a normal vitest `test()`.
- [api-design] When a function must both infer the caller's literal options type AND reject unknown keys, take `TOptions extends KnownOptions` and type the parameter as `ValidateShape<TOptions, KnownOptions>` (resolves to the expected shape when extra keys exist), then derive dependent types from `TOptions` fields.
  WHY: A plain `opts: KnownOptions` parameter loses the literal type needed for conditional derivation, and a bare generic loses excess-property checking — this pattern keeps both.
  EX: initTRPC.ts: `create<TOptions extends RuntimeConfigOptions>(opts?: ValidateShape<TOptions, RuntimeConfigOptions>)` then `errorShape: undefined extends TOptions['errorFormatter'] ? DefaultErrorShape : inferErrorFormatterShape<...>`.
- [structure] Quarantine complex internals in an explicitly named internal module and build the public entrypoint as a curated named re-export list that renames on export (`export { AnyProcedure as AnyTRPCProcedure }`); keep internal names short and unprefixed, and use `export *` only inside the internal layer.
  WHY: Internal code stays readable while the public namespace is collision-safe and every public symbol is a deliberate decision — deleting internals can't silently break consumers.
  EX: server/src/unstable-core-do-not-import/ (header: 'DO NOT IMPORT FROM THIS FILE') vs @trpc/server/index.ts: `export { type RouterRecord as TRPCRouterRecord, createFlatProxy as createTRPCFlatProxy, ... }`.
- [runtime] When merging config/def objects that should never collide, use a merge helper that throws on a duplicate key with a different value (`mergeWithoutOverrides`) instead of silent spread-override.
  WHY: Turns a subtle wrong-config bug (later spread silently wins) into an immediate, named failure at composition time.
  EX: utils.ts:10 `if (key in newObj && newObj[key] !== overrides[key]) throw new Error(`Duplicate key ${key}`)` — used by createNewBuilder for every builder chain step.

## Matt Pocock / Total TypeScript (totaltypescript.com articles: discriminated-unions-are-a-devs-best-friend, noinfer, const-type-parameters, four-essential-typescript-patterns, immediately-indexed-mapped-type, where-to-put-your-types-in-application-code, why-i-dont-like-typescript-enums; github.com/total-typescript/ts-reset)
- [types] Model state as a discriminated union with one literal tag field, never as a bag of optional properties or boolean flags.
  WHY: Optional-property shapes admit impossible states (success with no data), pushing invalid-state handling into runtime checks and defensive code.
  EX: // bad
type State = { status: 'loading'|'success'|'error'; data?: Data; error?: Error }
// good
type State = { status: 'loading' } | { status: 'success'; data: Data } | { status: 'error'; error: Error }
- [types] Make every switch over a discriminated union exhaustive by asserting the default case is never (e.g. `default: state satisfies never`).
  WHY: Adding a union member then becomes a compile error at every handler instead of a silently unhandled branch.
  EX: switch (s.status) {
  case 'loading': ...
  case 'success': ...
  default: { s satisfies never; throw new Error('unreachable') }
}
- [api-design] Only introduce a type parameter when it links two positions (input↔output or param↔param); if the parameter appears once, use a union or plain type instead.
  WHY: A single-use generic adds API complexity without changing inference — the caller gets nothing a union wouldn't give.
  EX: // bad: <T extends string>(name: T) => void
// good: (name: 'a' | 'b') => void
// good generic: <T>(items: T[]) => T  // T links input to output
- [errors] Type all data crossing a trust boundary (JSON.parse, fetch().json(), env, IPC payloads) as unknown and narrow with a schema or predicate — never accept the default any.
  WHY: any silently disables checking downstream of every I/O call, which is where real bugs enter; unknown forces validation at the boundary.
  EX: const raw: unknown = JSON.parse(input); // ts-reset behavior
const msg = MessageSchema.parse(raw);
- [types] Validate config-shaped object literals with `satisfies`, not a type annotation or `as` — keep the inferred literal type while checking conformance.
  WHY: An annotation widens keys/values and loses per-key inference; `as` skips checking entirely; `satisfies` gives both checking and precise inference.
  EX: const routes = {
  home: '/', user: '/user/:id',
} satisfies Record<string, string>;
routes.home // type '/' — annotation would give string
- [types] Brand primitive types that carry validated meaning (UserId, ChatId, Password) so raw strings/numbers can't cross the validation boundary unchecked.
  WHY: Structural typing lets any string satisfy an id parameter, allowing id-swap bugs (passing a chatId where a userId goes) to type-check.
  EX: type UserId = string & { readonly __brand: 'UserId' };
const toUserId = (s: string): UserId => { assertValid(s); return s as UserId; };
getUser(chatId) // now a compile error
- [api-design] In a generic function with multiple parameters of the same type family, wrap the parameters that should be checked (not inferred from) in NoInfer.
  WHY: Without it TypeScript unions all candidate sites, so an invalid value widens the inferred type instead of erroring.
  EX: declare function createFSM<TState extends string>(config: {
  initial: NoInfer<TState>;
  states: TState[];
}): TState;
// initial must now be one of states
- [api-design] In library APIs where callers pass literal configs (tool names, event keys, route tables), declare the type parameter as `const T` to preserve literal types without requiring callers to write `as const`.
  WHY: Widening to string/number destroys downstream key-level inference the API was designed to provide.
  EX: const defineTools = <const T extends { name: string }[]>(tools: T) => tools;
const t = defineTools([{ name: 'search' }]);
// t[0].name: 'search', not string
- [errors] Encode runtime validation as type predicates (`value is T`) or assertion functions (`asserts value is T`) so the check narrows the type at the call site instead of being followed by a cast.
  WHY: A boolean-returning check plus `as T` duplicates the invariant and lets the cast drift from the check.
  EX: function assertIsAdmin(u: User): asserts u is AdminUser {
  if (u.role !== 'admin') throw new Error('not admin');
}
assertIsAdmin(user); user.adminPerms // narrowed, no cast
- [types] Never use enum; use an `as const` object plus a derived union type (`typeof X[keyof typeof X]`) or a plain literal union.
  WHY: Enums have nominal type-checking quirks, emit runtime code (breaking types-only expectations and erasableSyntaxOnly), and force callers to import the enum to pass a value.
  EX: const Status = { Open: 'open', Closed: 'closed' } as const;
type Status = typeof Status[keyof typeof Status]; // 'open' | 'closed'
- [structure] Co-locate a type in the file that uses it; promote it to a shared types file only at the smallest scope that actually imports it (feature dir → package → shared package).
  WHY: A global types.ts becomes a dumping ground with false coupling; scope-matched placement keeps refactors local.
  EX: // used once → same file as the function
// used across features/ chat → features/chat/types.ts
// used across packages → packages/types (last resort)
- [types] Derive a discriminated union from a payload map with an immediately indexed mapped type instead of hand-writing parallel union members.
  WHY: One source of truth: adding an event/message kind updates the union, handlers, and payload types together instead of drifting.
  EX: type EventMap = { open: { id: string }; close: { reason: string } };
type Event = { [K in keyof EventMap]: { type: K } & EventMap[K] }[keyof EventMap];
- [api-design] Annotate explicit return types on exported and top-level module functions; let inference handle local closures.
  WHY: Explicit boundaries stop accidental API changes from leaking through inference and localize type errors to the function that caused them.
  EX: export function loadChat(id: ChatId): Promise<Chat> { ... }
// internal helper: const toRow = (c) => ({...}) — inference fine
- [structure] Augment the global scope (`declare global`, process.env, Window) in exactly one dedicated .d.ts per package, and never ship global augmentations (or ts-reset-style lib overrides) from a library.
  WHY: Scattered or exported global merges silently rewrite types for every consumer and make conflicts undiagnosable.
  EX: // env.d.ts (app-level only)
declare global { namespace NodeJS { interface ProcessEnv { ARDEN_DIR: string } } }
export {}

## zod v4 (github.com/colinhacks/zod, packages/zod/src/v4 — core/errors.ts, core/util.ts, core/api.ts, core/schemas.ts, core/core.ts, classic/schemas.ts)
- [errors] Model every error/event variant as its own interface with a literal `code` discriminant extending a shared base, and export the union of them; never one wide interface with optional fields.
  WHY: Consumers get exhaustive `switch (issue.code)` narrowing and each variant only carries fields that exist for it, so no defensive `if (x.maximum !== undefined)` code.
  EX: interface IssueTooBig extends IssueBase { readonly code: "too_big"; readonly maximum: number | bigint }  // errors.ts: $ZodIssue = $ZodIssueInvalidType | $ZodIssueTooBig | ...
- [errors] Give success/failure result types an explicit `never`-typed absent field on each arm (`{ success: true; data: T; error?: never }`) so both arms destructure without casts.
  WHY: Plain `{success:true;data:T} | {success:false;error:E}` forces narrowing before touching either field; the `?: never` trick lets `const { data, error } = result` compile and still narrow on `success`.
  EX: type SafeParseSuccess<T> = { success: true; data: T; error?: never }  // core/util.ts:215
- [types] Use `const` type parameters on any function that accepts literals, tuples, or option arrays whose exact values matter downstream.
  WHY: Without `const`, `union([a, b])` widens to an unordered array type and `literal("x")` widens to `string`, destroying inference for everything built on top.
  EX: export function literal<const T extends util.Literal>(value: T): ZodLiteral<T>;  export function union<const T extends readonly SomeType[]>(options: T): ZodUnion<T>
- [api-design] Type chainable/wrapper methods with `this` woven into the return type (`optional(): ZodOptional<this>`, `or<T>(o: T): ZodUnion<[this, T]>`) instead of the base class.
  WHY: Subclass identity and every inferred type parameter survive the chain; returning the base type erases everything a caller built up.
  EX: interface ZodType { optional(): ZodOptional<this>; refine<Ch>(check: Ch): Ch extends (a: any) => a is infer R ? this & ZodType<R, input<this>> : this }  // classic/schemas.ts:104-118
- [types] Encode call-site invariants in parameter types — non-empty via `[T, ...T[]]`, capability via a narrowed constraint type — rather than validating shape at runtime only.
  WHY: Misuse (empty option list, option that can't be discriminated) becomes a compile error at the call instead of a runtime failure later.
  EX: function discriminatedUnion<Types extends readonly [$ZodTypeDiscriminable, ...$ZodTypeDiscriminable[]], Disc extends string>(discriminator: Disc, options: Types)
- [errors] For invariants types can't express, throw at construction/definition time with a message naming the offending element — never defer to first use.
  WHY: A bad config fails where it was written (with an index/name to fix), not on the first production input that happens to hit it.
  EX: // schemas.ts:2571 — checked at the discriminatedUnion() call, 'so an option that lacks the discriminator fails ... instead of on the first object parsed': throw new Error(`Invalid discriminated union option at index "${i}"`)
- [errors] For expected failures inside hot or shared code paths, return documented typed sentinel constants unioned with the success type instead of throwing or returning boolean.
  WHY: The caller can distinguish failure stages for good error messages while cheap callers just check 'not success', with no try/catch cost or lost information.
  EX: export const URL_BAD_FORMAT = 1; export const URL_UNPARSEABLE = 2; function parseURLObject(s): URL | typeof URL_BAD_FORMAT | typeof URL_UNPARSEABLE  // schemas.ts:~500
- [types] Derive secondary API types (params objects, option bags) from the source-of-truth type via Omit/Partial/keyof instead of restating the fields.
  WHY: Adding a field to the def automatically propagates to every factory's params type; hand-copied param interfaces silently drift.
  EX: type Params<T, Issues, OmitKeys> = Flatten<Partial<Omit<T["_zod"]["def"], OmitKeys> & { error?: $ZodErrorMap<Issues> }>>  // core/api.ts:8
- [types] When a string union must accept arbitrary strings but still autocomplete known values, union with `(string & {})`.
  WHY: Plain `"a" | "b" | string` collapses to `string` and kills IDE suggestions; the `& {}` keeps the literals distinct for completion.
  EX: type Expected = "string" | "number" | ... | (string & {})  // errors.ts:41, for instanceof class names
- [types] Replace boolean flags that will ever grow a third state with a documented literal-union field where `undefined` is the base state, and document which comparison answers which question.
  WHY: Two booleans for a three-rung ladder invite illegal combinations; one union field makes each strength level and its test explicit.
  EX: /** undefined — required; "optional" — may be omitted; "defaulted" — omitted AND substituted. Consumers asking "may the slot be absent?" test !== undefined */ optin?: "optional" | "defaulted" | undefined  // schemas.ts:~128
- [types] Annotate output-only type parameters on public generic interfaces with `out` variance.
  WHY: It documents intent, lets the checker skip structural variance measurement on large recursive types (faster), and rejects unsound assignments early.
  EX: interface $ZodTypeInternals<out O = unknown, out I = unknown> extends _$ZodTypeInternals { output: O; input: I }  // schemas.ts:179
- [api-design] Accept ergonomic shorthand (`string | ParamsObject`) at every public entry point and normalize it once in one shared boundary function; internals only ever see the canonical shape.
  WHY: Callers get the terse form everywhere consistently, while normalization logic (and its edge cases, like message/error conflicts) lives in exactly one place.
  EX: function _email<T>(Class, params?: string | $ZodEmailParams): T { return new Class({ ...defaults, ...util.normalizeParams(params) }) }  // api.ts; normalizeParams turns a string into { error: () => s }
- [api-design] Put type precision in overload signatures and keep the single implementation signature loose (`any`), rather than one signature returning a union.
  WHY: Callers get the exact return type for their argument shape (array → union of members, scalar → that literal) instead of a union they must narrow.
  EX: function literal<const T extends ReadonlyArray<Literal>>(v: T): ZodLiteral<T[number]>; function literal<const T extends Literal>(v: T): ZodLiteral<T>; function literal(value: any, params: any) { ... }  // classic/schemas.ts:2150
- [types] Make tolerant type accessors that conditionally extract with an `unknown` fallback instead of constraining the generic (`input<T> = T extends { _zod: { input: any } } ? ... : unknown`).
  WHY: Utility types stay usable in generic contexts and partial types without cascading constraint errors, while still resolving precisely for real schemas.
  EX: export type output<T> = T extends { _zod: { output: any } } ? T["_zod"]["output"] : unknown; export type { output as infer }  // core/core.ts:139

## Vercel AI SDK (github.com/vercel/ai, shallow clone @ main 2026-08-22; packages/ai/src, packages/provider/src, packages/anthropic/src)
- [api-design] Model a stream as ONE discriminated union of typed parts, where metadata, warnings, and errors are stream parts too — never side channels; multi-chunk items use start/delta/end triples keyed by a shared id.
  WHY: Consumers handle everything with one switch, errors can occur mid-stream without breaking the pipe, and concurrent blocks (text + reasoning + tool input) interleave safely.
  EX: packages/provider/src/language-model/v4/language-model-v4-stream-part.ts — `type LanguageModelV4StreamPart = {type:'text-start';id} | {type:'text-delta';id;delta} | {type:'text-end';id} | ... | {type:'stream-start';warnings} | {type:'response-metadata';...} | {type:'finish';usage;finishReason} | {type:'error';error:unknown}`
- [api-design] Version the internal provider/plugin interface with a literal discriminant field and keep old versions as parallel modules; evolve the user-facing API separately from the spec.
  WHY: Lets third-party implementations declare which contract they satisfy and lets the core support several at once instead of a flag-day breaking change.
  EX: packages/provider/src/language-model/{v2,v3,v4}/ coexist; `type LanguageModelV4 = { readonly specificationVersion: 'v4'; doGenerate(...); doStream(...) }`. Call-options docs note the spec prompt 'is NOT the user-facing prompt' so the public API can evolve independently.
- [types] Normalize provider values into a unified vocabulary but always carry the raw value alongside — pattern: `{ unified: <closed union>, raw: string | undefined }` and `usage.raw?: JSONObject`.
  WHY: Cross-provider code can switch on the unified value while nothing provider-specific is ever lost to normalization.
  EX: packages/provider/src/language-model/v4/language-model-v4-finish-reason.ts — `{ unified: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other'; raw: string | undefined }`; usage fields are `number | undefined`, never 0-for-unknown.
- [errors] Report capability gaps as typed warnings collected into the result, not thrown errors: push `{type:'unsupported', feature}` / `{type:'compatibility'|'deprecated', ...}` onto a warnings array and keep going.
  WHY: A backend missing one knob (e.g. frequencyPenalty) should degrade the call, not kill it; the typed union keeps warnings machine-inspectable.
  EX: packages/anthropic/src/anthropic-language-model.ts:248 — `if (frequencyPenalty != null) warnings.push({ type: 'unsupported', feature: 'frequencyPenalty' })`; union in packages/provider/src/shared/v4/shared-v4-warning.ts
- [errors] Give every error class a Symbol.for marker plus a static `isInstance(error: unknown): error is X` type guard instead of relying on `instanceof`.
  WHY: instanceof breaks when two copies of the library are loaded (npm dedupe failure, version skew across packages); Symbol.for markers survive it and the guard narrows `unknown` from catch blocks.
  EX: packages/provider/src/errors/api-call-error.ts — `const symbol = Symbol.for('vercel.ai.error.AI_APICallError'); class APICallError extends AISDKError { private readonly [symbol] = true; static isInstance(e: unknown): e is APICallError { return AISDKError.hasMarker(e, marker); } }`
- [errors] Make transport errors carry a computed `isRetryable` plus the full request/response context as readonly fields, with retryability derived from status code as a constructor DEFAULT the caller can override.
  WHY: Retry policy lives in one place on the error itself; handlers never re-parse messages or status codes to decide whether to retry.
  EX: APICallError: `isRetryable = statusCode != null && (statusCode === 408 || 409 || 429 || statusCode >= 500)` as a destructuring default; readonly url, requestBodyValues, statusCode, responseHeaders, responseBody, data
- [api-design] Public functions take a single options object destructured in the signature with defaults inline, and generic parameters are inferred from the config the caller passes (e.g. the tool set), never annotated by hand.
  WHY: Named parameters stay backward-compatible as options grow, and inference threads tool-name/result types through steps, callbacks, and results for free.
  EX: packages/ai/src/generate-text/generate-text.ts:233 — `async function generateText<TOOLS extends ToolSet, RUNTIME_CONTEXT extends Context = Context>({ model, tools, stopWhen = isStepCount(1), maxRetries, ... })`
- [api-design] Express loop-control policy as small named predicate factories over accumulated state instead of numeric knobs: `stopWhen: isStepCount(5)` / `hasToolCall('finalize')`, evaluated with any-of semantics.
  WHY: Policies compose (pass an array), stay testable as pure functions, and new stopping rules need no new option fields on the core function.
  EX: packages/ai/src/generate-text/stop-condition.ts — `type StopCondition<TOOLS> = (o: { steps: StepResult<TOOLS>[] }) => boolean | PromiseLike<boolean>`; `hasToolCall<TOOLS>(...toolName: Array<keyof TOOLS | (string & {})>)`
- [types] For string unions meant to guide, not restrict, append `| (string & {})` — known values get autocomplete but arbitrary strings still type-check.
  WHY: Keeps model/tool-name lists open so new backend values don't require a library release, without losing IDE completion.
  EX: packages/anthropic/src/anthropic-language-model-options.ts — `type AnthropicModelId = 'claude-opus-4-5' | ... | (string & {})`
- [types] Close every switch over a discriminated union with a `const _exhaustiveCheck: never = value` default arm, and use `satisfies` when building union members so excess/missing keys fail at the construction site.
  WHY: Adding a union variant becomes a compile error at every non-updated switch instead of a silent fall-through at runtime.
  EX: packages/anthropic/src/convert-to-anthropic-prompt.ts:1365 — `default: { const _exhaustiveCheck: never = role; throw new Error(`Unsupported role: ${_exhaustiveCheck}`); }`; line 179 `} satisfies AnthropicToolChangeContent`
- [testing] Inject nondeterminism through a defaulted `_internal` options group (`_internal: { generateId = originalGenerateId, now = originalNow } = {}`) rather than module mocking or extra top-level params.
  WHY: Tests pin ids and clocks deterministically while the public option surface stays clean — the underscore signals 'not for consumers' without a separate test build.
  EX: packages/ai/src/generate-text/generate-text.ts — `_internal: { generateId = originalGenerateId, generateCallId = originalGenerateCallId, now = originalNow } = {}` in the destructured signature
- [api-design] Stage API churn in the options object itself: prefix unstable options `experimental_`, and when one stabilizes keep the old name as a destructuring-default alias (`telemetry = experimental_telemetry`) instead of deleting it.
  WHY: Consumers get an explicit stability signal and a zero-cost migration path; renames never hard-break callers.
  EX: generate-text.ts — `experimental_telemetry, telemetry = experimental_telemetry` and `experimental_repairToolCall, repairToolCall = experimental_repairToolCall`
- [naming] Name internal-contract methods so misuse is visible: implementation-facing methods get a `do` prefix (doGenerate/doStream) distinct from the public verbs (generateText/streamText).
  WHY: The prefix stops consumers from calling the raw spec method that skips retries, telemetry, and normalization — the name itself encodes the layering.
  EX: language-model-v4.ts — `doGenerate(...)` with comment: "Naming: 'do' prefix to prevent accidental direct usage of the method by the user."
- [structure] Structure each provider adapter as one file per pure mapping (convert-X, map-Y, sanitize-Z) with a co-located test, keeping the model class as thin orchestration; a streaming result offers multiple lazy views of one underlying stream (tee for textStream/fullStream, DelayedPromise for late scalars like usage).
  WHY: Pure per-file converters are unit-testable without HTTP, and lazy views let callers consume only what they need without buffering or double-consuming the stream.
  EX: packages/anthropic/src: convert-to-anthropic-prompt.ts, map-anthropic-stop-reason.ts, convert-anthropic-usage.ts each with a .test.ts; stream-text.ts — `get textStream() { return this.teeStream().pipeThrough(...) }`, `private readonly _totalUsage = new DelayedPromise<...>()`

## ~/src/refs/mastra (AGENTS.md, packages/core/AGENTS.md, .claude/skills/react-best-practices/references/rules/types-*.md, packages/_internal-core/src/error/) + ~/src/refs/codex/AGENTS.md (language-agnostic craft rules only)
- [types] Never use `as` type assertions anywhere, tests included; narrow with predicate type guards that actually prove the fields used, generic type arguments, typed fixture factories, `implements` on mocks, or `satisfies` — only `as const` is allowed.
  WHY: A cast is an unchecked claim: refactors that change the real shape never flag the cast site, so drift breaks at runtime — and test-fixture casts hide exactly the drift tests exist to catch.
  EX: Bad: `const meta = msg.content.metadata as MessageMetadata; const el = document.querySelector('[data-x]') as HTMLElement;` Good: `const el = document.querySelector<HTMLElement>('[data-x]'); if (!el) throw new Error('missing'); const meta = isMessageMetadata(v) ? v : undefined;` — and a guard that only checks `typeof v === 'object' && v !== null` must be named `isRecord`, not `is MessageMetadata`. (mastra types-no-type-assertions.md)
- [types] Model absence as `undefined` (`?` / `| undefined`), never `| null`, inside the codebase; convert external `null` once at the boundary with `?? undefined` and keep leaf APIs strict so callers own absence and fallbacks.
  WHY: One absence representation eliminates double checks (`x !== null && x !== undefined`), impossible states, and null propagating through layers.
  EX: Bad: `useState<User | null>(null)`; `type Props = { user: User | null }`. Good: `function fromApiUser(u: ApiUser): User { return { id: u.id, avatarUrl: u.avatarUrl ?? undefined } }` — `.find()` already returns undefined; don't re-wrap it in null. (mastra types-no-null.md)
- [types] Make switches over discriminated unions exhaustive with no default/wildcard arm; let the compiler flag new variants instead of silently routing them to a catch-all.
  WHY: A wildcard arm turns an added union member into a silent runtime misroute instead of a compile error at every switch that must handle it.
  EX: Bad: `switch (ev.type) { case 'text': …; default: return }`. Good: cover every member; if a fallthrough is truly needed, end with `default: { const _x: never = ev; throw new Error(_x) }`. (codex AGENTS.md: "make match statements exhaustive and avoid wildcard arms")
- [api-design] Never design functions with bare boolean or nullable positional parameters that produce opaque callsites like `foo(false)` or `bar(undefined)`; use union-literal parameters, named options objects, or separate named functions so the callsite is self-documenting.
  WHY: Opaque positional literals make every callsite a guessing game and make argument-order bugs invisible in review.
  EX: Bad: `renderRow(item, true, undefined)`. Good: `renderRow(item, { selected: true })` or `select(item)` / `deselect(item)`, or `mode: 'compact' | 'full'`. (codex AGENTS.md: avoid bool/ambiguous Option params; TS translation of its enum/newtype advice)
- [errors] Throw one structured error class carrying a stable UPPERCASE id, a domain enum, a category enum (USER | SYSTEM | THIRD_PARTY), and JSON-safe `details`; normalize caught `unknown` into a real Error via one shared helper and chain it as `cause`, never re-wrap by string concatenation.
  WHY: Errors that self-serialize with stable codes and provenance can be logged, matched on, and returned over the wire without ad-hoc parsing, and the cause chain survives.
  EX: `class MastraBaseError<D, C> extends Error { readonly id: Uppercase<string>; readonly domain: D; readonly category: C; readonly details?: Record<string, Json<Scalar>>; toJSON(): …ateErrorJSON }` built from `getErrorFromUnknown(originalError)` as cause. (mastra packages/_internal-core/src/error/index.ts:48-142)
- [types] Constrain any payload that crosses a serialization boundary (persistence, IPC, wire, error details) to JSON-safe types at the type level, and keep live handles/closures in a separate non-serialized runtime scope — never on the serialized schema.
  WHY: The type system, not a runtime crash in JSON.stringify or a corrupt row, should catch a Date/Map/closure sneaking into persisted state.
  EX: `type Json<T> = [T] extends [Scalar | undefined] ? Scalar : [T] extends [{[x:number]: unknown}] ? {[K in keyof T]: Json<T[K]>} : never; details?: Record<string, Json<Scalar>>` (mastra error/index.ts:36-42); mastra core AGENTS.md: "Do not put runScope values on step input/output schemas — those cross the wire and must stay JSON-safe."
- [api-design] Keep each package's public API surface minimal and explicit: private modules by default, deliberate exports only, and no test-only helpers exported from the main implementation — put test scaffolding in test files or a dedicated test-support module.
  WHY: Every export is a compatibility contract; accidental surface (especially test helpers) gets depended on and freezes internals.
  EX: Bad: `export function __resetStateForTests()` in `store.ts`. Good: keep it unexported and reach it from a colocated test, or move it to `test-support/`. (codex AGENTS.md: "Prefer private modules and explicitly exported public crate API… Avoid proliferating test-only helpers")
- [api-design] At public API boundaries use plain `string` IDs (parse to branded/UUID types internally), integer Unix-seconds timestamps named `*_at`, and give every list endpoint cursor pagination by default: request `cursor?/limit?`, response `data/next_cursor`.
  WHY: Boundary types that are trivially serializable and uniformly shaped avoid version-skew breakage and retrofitting pagination onto endpoints that grew.
  EX: `{ cursor?: string; limit?: number } → { data: Thread[]; next_cursor?: string }`, fields `created_at: number` (unix seconds). (codex AGENTS.md app-server rules: plain String IDs at the API boundary; `*_at` i64 timestamps; cursor pagination for new list methods)
- [structure] Cap module size: when a file passes ~500 lines (hard stop ~800, tests excluded), put new functionality in a new module instead of extending it — and when extracting, move the related tests and type docs with the code; keep high-traffic orchestration files orchestration-only.
  WHY: Large high-touch files attract unrelated changes, merge conflicts, and invariants that drift away from the code that owns them.
  EX: codex AGENTS.md: "Target modules under 500 LoC… if a file exceeds roughly 800 LoC, add new functionality in a new module"; "keep chatwidget.rs focused on orchestration" — same discipline for a TS server's central loop/session files.
- [structure] Do not extract a helper function that has exactly one caller; inline the code at its only callsite until a second real caller exists.
  WHY: Single-use helpers add indirection and a name to maintain without removing any duplication, making the one real code path harder to read.
  EX: Bad: `function buildHeaderLine(run: Run) {…}` called once from `renderRun`. Good: the four lines live in `renderRun`. (codex AGENTS.md: "Do not create small helper methods that are referenced only once")
- [structure] Resist adding new concepts to the largest core package by default; before extending it, check whether an existing smaller package fits or whether it's time to create a new one — refactoring to make that possible is part of the change.
  WHY: The biggest package is always the path of least resistance, so it bloats monotonically until everything depends on everything.
  EX: codex AGENTS.md: "resist adding code to codex-core! …consider whether it is time to introduce a new crate… do not hesitate to push back on PRs that would unnecessarily add code to codex-core." Same pressure exists on any monorepo's `core`/`server` package.
- [testing] In tests, assert deep equality on whole objects rather than field-by-field, and never write tests that re-assert statically defined constants or negative tests for code that was deleted.
  WHY: Whole-object equality catches unexpected extra/changed fields that per-field asserts silently ignore, while constant-echo tests add maintenance cost with zero failure-detection power.
  EX: Bad: `expect(r.id).toBe('a'); expect(r.status).toBe('done')` (misses a new `error` field). Good: `expect(r).toEqual({ id: 'a', status: 'done' })`. (codex AGENTS.md test assertions + "Do not add tests for values that are statically defined")
- [testing] Never mutate `process.env` (or other process-global state) inside tests; thread environment-derived flags in as parameters or injected config from above.
  WHY: Env mutation leaks across parallel tests and orders, producing flakes that reproduce only in CI.
  EX: Bad: `process.env.LOG_DIR = tmp; runServer()`. Good: `runServer({ logDir: tmp })`. (codex AGENTS.md: "Avoid mutating process environment in tests; prefer passing environment-derived flags from above")
- [types] A parameter that a downstream call depends on is either the value or `undefined` — never `| null` and never a fabricated fallback like `id ?? ''`; narrow at the caller so the callee's signature stays strict.
  WHY: Fake fallbacks turn a type error into a silently wrong runtime call (fetching `''`), and `| null` params force every layer to re-check.
  EX: Bad: `useThread(threadId ?? '')`. Good: caller renders nothing until `threadId` exists, so `useThread(threadId: string)` stays strict. (mastra SKILL.md client-request-dedupe: "the value or `undefined`, never `| null` or a fake fallback; narrow at the caller")
