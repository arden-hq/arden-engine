import { Schema } from "effect"
import {
  deriveAuthority,
  type AdmissionFacts,
  type RunAuthority
} from "../src/execution/authority.js"
import type { CallFacts, Decision, LiveSettings } from "../src/execution/decide.js"
import type { RunPolicy } from "../src/execution/policy.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { defaultImpact } from "../src/execution/impact.js"
import { defineServerTool, type ServerTool } from "../src/tools/define.js"

export const policy: RunPolicy = {
  budget_id: "budget",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space: {
    space_id: "space-a",
    generation: 1,
    inference: { enabled: false }
  }
}

export const admitted = (overrides: Partial<AdmissionFacts>): RunAuthority =>
  deriveAuthority({
    sessionId: "chat-1",
    context: { origin: { kind: "chat", session_id: "chat-1", turn_id: "t1" }, task: null },
    policy,
    originOwner: null,
    chatOwner: null,
    ...overrides
  })

export const person = admitted({})

export const automation = admitted({
  context: {
    origin: { kind: "automation", automation_id: "auto-1", occurrence_id: "o1" },
    task: null
  },
  originOwner: { kind: "automation", key: "auto-1", purpose: "user_automation", handler: null }
})

export const tool = (
  name: string,
  metadata: {
    readonly action: "read" | "write"
    readonly effect?: "none" | "run_record" | "arden_db"
    readonly default_approval?: "approve" | "ask"
    readonly self_gated?: boolean
    readonly always_ask?: boolean
    readonly approval_bypass?: boolean
    readonly refuse_unattended?: boolean
    readonly requirement?: "boundary"
  },
  perCall = false
): ServerTool =>
  defineServerTool({
    name,
    description: name,
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      display_name: name,
      kind: "tool",
      action: metadata.action,
      source: "_test",
      effect: metadata.effect ?? (metadata.action === "read" ? "none" : "arden_db"),
      changes_state: metadata.action === "write",
      ...(metadata.action === "write" ? { target: "reported" as const } : {}),
      default_approval: metadata.default_approval ?? "approve",
      concurrency_group: null,
      destructive: false,
      ...(metadata.self_gated === true ? { read_only_mode: "self_gated" as const } : {}),
      ...(metadata.always_ask === true ? { always_ask: true } : {}),
      ...(metadata.approval_bypass === true ? { approval_bypass: true } : {}),
      ...(metadata.refuse_unattended === true ? { refuse_unattended: true } : {}),
      ...(metadata.requirement === undefined ? {} : { requirement: metadata.requirement })
    },
    ...(perCall ? { approvalRequirement: async () => undefined } : {}),
    ...(metadata.always_ask === true ? { approvalPrompt: async () => ({ preview: name }) } : {}),
    execute: async () => "done"
  })

export const live = (overrides: Partial<LiveSettings> = {}): LiveSettings => ({
  state: "active",
  mode: "ask",
  rule: undefined,
  ...overrides
})

export const call = (target: ServerTool, overrides: Partial<CallFacts> = {}): CallFacts => ({
  tool: toolFacts(target.definition),
  impact: defaultImpact(toolFacts(target.definition)),
  available: true,
  unattended_scope: false,
  floor: undefined,
  target: undefined,
  requirement: false,
  user_only: false,
  reads_only: true,
  approved: false,
  ...overrides
})

export const verdict = (decision: Decision): DecisionVerdict => {
  switch (decision.kind) {
    case "allow":
      return { allow: decision.by }
    case "ask":
      return { ask: decision.reason, ...decision.presentation }
    case "deny":
      return { deny: decision.rule, instead: decision.instead.map((path) => path.kind) }
  }
}

export const write = tool("space_task_update", { action: "write" })

type AskDecision = Extract<Decision, { readonly kind: "ask" }>
type DenyDecision = Extract<Decision, { readonly kind: "deny" }>

type DecisionVerdict =
  | { readonly allow: Extract<Decision, { readonly kind: "allow" }>["by"] }
  | ({ readonly ask: AskDecision["reason"] } & AskDecision["presentation"])
  | {
      readonly deny: DenyDecision["rule"]
      readonly instead: ReadonlyArray<DenyDecision["instead"][number]["kind"]>
    }
