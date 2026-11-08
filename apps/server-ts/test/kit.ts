import { makeReviewPlans } from "../src/tools/review-plans.js"
import { DateTime, Effect, Predicate, Schema } from "effect"
import {
  ruleOfSetting,
  type PermissionRule,
  type RuleDecision
} from "../src/persistence/permissions/rules.js"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import type { ServerToolRun } from "../src/chat/runner-contract.js"
import type { RunPolicy } from "../src/execution/policy.js"
import type { RunAuthority } from "../src/execution/authority.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import type { ApprovalGatePolicy } from "../src/tools/approval-gate.js"
import type { SessionHistoryHeader } from "../src/persistence/sessions/model.js"
import {
  makeBrowserObservationRegistry,
  makeObservationRegistry,
  type ServerRunContext
} from "../src/tools/run-context.js"
import type { CodeModeHost, ScriptHost } from "../src/workflows/runtime/contract.js"

const outside = (seam: string) => (): Promise<never> =>
  Promise.reject(new Error(`${seam} is outside this test`))

const runPolicy = (overrides: Partial<RunPolicy> = {}): RunPolicy => ({
  budget_id: "fixture",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space: null,
  ...overrides
})

export const runAuthority = (overrides: Partial<RunAuthority> = {}): RunAuthority => ({
  version: 1,
  actor: { kind: "person", session_id: "session-fixture", turn_id: "turn-fixture" },
  owns: {
    session_id: "session-fixture",
    space_id: null,
    automation_id: null,
    chain_depth: 0,
    task_item_id: null
  },
  reach: { capabilities: ["all"], observe: false },
  approval: { follows: { kind: "chat", session_id: "session-fixture" } },
  sandbox: { kind: "host_approved" },
  memory: { _tag: "Global" },
  delegation: { depth: 0, chain: [] },
  unattended: false,
  ...overrides
})

const serverToolRun = (overrides: Partial<ServerToolRun> = {}): ServerToolRun => ({
  sessionId: "session-fixture",
  runId: "run-fixture",
  policy: runPolicy(),
  authority: runAuthority(),
  approvalMode: "ask",
  executeTool: async (_request, operation) => operation(),
  executeDetachedTool: async (_request, operation) => operation(),
  spawnAgent: outside("spawn_agent"),
  cancelAgent: outside("cancel_agent"),
  sendMessage: outside("session_send_message"),
  detachedRun: outside("detached_run"),
  emitToolProgress: async () => undefined,
  emitToolOutput: async () => undefined,
  declareEffectTarget: async () => undefined,
  ...overrides
})

const codeModeHost = (overrides: Partial<CodeModeHost> = {}): CodeModeHost => ({
  call: outside("code_mode"),
  changesState: () => false,
  describe: () => undefined,
  scriptFields: () => undefined,
  ...overrides
})

const fakeScriptHost = (overrides: Partial<ScriptHost> = {}): ScriptHost => ({
  executionProfile: {
    hash: "fixture",
    modes: { research: { changesState: false }, code: { changesState: true } }
  },
  agent: outside("dynamic workflow agent"),
  tool: outside("dynamic workflow tool"),
  changesState: () => false,
  describe: () => undefined,
  ...overrides
})

const snapshotRef = (n: number): string => `snap-${n.toString(16).padStart(12, "0")}`

export const serverRunContext = (overrides: Partial<ServerRunContext> = {}): ServerRunContext => {
  let refs = 0
  return {
    ...serverToolRun(),
    observations: makeObservationRegistry(),
    browserObservations: makeBrowserObservationRegistry({ newRef: () => snapshotRef(++refs) }),
    mayUseBrowserTab: async () => true,
    reviewPlans: makeReviewPlans(),
    codeMode: codeModeHost(),
    scriptHost: fakeScriptHost(),
    scriptHostFor: () => {
      throw new Error("script_host_for is outside this test")
    },
    offerPermission: async () => ({ kind: "skipped" }),
    readPermissions: () => Promise.reject(new Error("readPermissions is outside this test")),
    ...overrides
  }
}

export const recordOf = (value: unknown): { readonly [key: string]: unknown } => {
  if (!Predicate.isReadonlyObject(value))
    throw new Error(`expected an object, got ${JSON.stringify(value)}`)
  return value
}

type Methods<S> = { readonly [K in keyof S]: (...args: never) => unknown }

export const partialService = <S extends Methods<S>>(port: string, given: Partial<S>): S => {
  const unplanned = (method: string) => (): never => {
    throw new Error(`${port}.${method} is outside this test`)
  }
  const fake = new Proxy(given, {
    get: (target, key) =>
      typeof key === "symbol" || key === "then" || key in target
        ? Reflect.get(target, key)
        : unplanned(key)
  })
  return fake as S
}

export const present = <A>(value: A | null | undefined, what: string): A => {
  if (value === undefined || value === null) throw new Error(`expected ${what}`)
  return value
}

export const sessionHeader = (
  overrides: Partial<SessionHistoryHeader> = {}
): SessionHistoryHeader => {
  const at = DateTime.makeUnsafe("2026-09-01T00:00:00Z")
  return {
    originJobPurpose: null,
    sessionId: "session-fixture",
    publicRef: "chat~session-fixture",
    startedAt: at,
    lastActivity: at,
    name: null,
    sessionType: "chat",
    originAutomationId: null,
    parentSessionId: null,
    parentRunId: null,
    parentToolCallId: null,
    parentMessageId: null,
    spaceId: null,
    chatModel: null,
    activeMessageCount: 0,
    lastInputTokens: null,
    contextGeneration: 0,
    ...overrides
  }
}

export const liveMode = Effect.fn("test.liveMode")(function* (runId: string) {
  const authority = yield* (yield* RunQueries).authority(runId)
  if (authority === undefined) return yield* Effect.die(`run ${runId} has no stored authority`)
  const live = yield* (yield* ApprovalPolicyStore).live({ runId, authority })
  return live.state === "active" ? live.mode : live.state
})

const globalRule = (tool: string, decision: RuleDecision): PermissionRule => ({
  id: `${tool}-${decision}`,
  subject: { kind: "tool", tool, server: null },
  list: { kind: "global" },
  decision,
  source: { kind: "settings", runId: null },
  createdAt: null,
  fromRuleId: null
})

const wordsRule = (text: string): PermissionRule => ({
  id: `words-${text}`,
  subject: { kind: "words", text },
  list: { kind: "global" },
  decision: "never",
  source: { kind: "settings", runId: null },
  createdAt: null,
  fromRuleId: null
})

export const gatePolicy = (
  mode: ChatApprovalMode,
  options: {
    readonly granted?: ReadonlyArray<string>
    readonly overrides?: Readonly<Record<string, "approve" | "ask" | "deny">>
    readonly deferred?: Array<string>
    readonly offered?: Array<string>
    readonly noApproval?: boolean
    readonly words?: ReadonlyArray<string>
  } = {}
): ApprovalGatePolicy => ({
  live: async () => ({
    state: "active",
    mode,
    noApproval: options.noApproval ?? false,
    currentScope: undefined,
    rules: {
      own: undefined,
      rules: [
        ...Object.entries(options.overrides ?? {}).map(([tool, setting]) =>
          globalRule(tool, ruleOfSetting(setting))
        ),
        ...(options.granted ?? []).map((tool) => globalRule(tool, "allow")),
        ...(options.words ?? []).map((text) => wordsRule(text))
      ]
    }
  }),
  reach: () => ({ available: true, unattended_scope: false }),
  defer: async (input) => {
    options.deferred?.push(input.name)
  },
  offer: async (input) => {
    options.offered?.push(input.name)
  },
  refusals: async () => 0
})

export const decodeRows = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  rows: unknown
): ReadonlyArray<S["Type"]> => Schema.decodeUnknownSync(Schema.Array(schema))(rows)

export const decodeRow = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  row: unknown
): S["Type"] => Schema.decodeUnknownSync(schema)(row)
