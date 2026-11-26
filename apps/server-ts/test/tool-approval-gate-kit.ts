import { PauseRequested, createToolset, type StandardSchemaV1, type Toolset } from "@arden-hq/loop"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import type { ApprovalReview, ApprovalReviewVerdict } from "../src/tools/approval-review.js"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { unrecordedAuthority } from "../src/execution/authority.js"
import {
  defineServerTool,
  type ServerTool,
  type ServerToolMetadataInput
} from "../src/tools/define.js"
import { gatePolicy, serverRunContext } from "./kit.js"

const unused = (): never => {
  throw new Error("not used by this test")
}

export const run = serverRunContext({
  sessionId: "session-1",
  runId: "run-1",
  policy: {
    budget_id: "run-1",
    budget_generation: 0,
    execution: { mode: "worker", observe: false },
    capabilities: ["all"],
    auto_approve: false,
    google_accounts: null,
    space: null
  },
  approvalMode: "ask",
  codeMode: {
    call: unused,
    changesState: () => false,
    describe: () => undefined,
    scriptFields: () => undefined
  },
  scriptHost: {
    executionProfile: {
      hash: "unused",
      modes: {
        research: { changesState: false },
        code: { changesState: true }
      }
    },
    agent: unused,
    tool: unused,
    changesState: () => false
  }
})

export const pathArgs: StandardSchemaV1<unknown, { readonly path?: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value ?? {} })
  }
}

export const metadata: ServerToolMetadataInput = {
  display_name: "Workspace",
  kind: "tool",
  action: "write",
  source: "_test",
  effect: "arden_db",
  changes_state: true,
  target: "reported",
  concurrency_group: null,
  destructive: false,
  approval_preview: "Use this workspace."
}

const workspace = (
  extra: Partial<ServerToolMetadataInput> = {},
  userOnly = false,
  pausesConnection = false
): ServerTool =>
  defineServerTool({
    name: "workspace",
    description: "Use a workspace",
    parameters: pathArgs,
    metadata: { ...metadata, ...extra },
    approvalRequirement: (input) => {
      if (pausesConnection) return Promise.reject(new PauseRequested("connection", "Sign in"))
      if (input.path === undefined) return undefined
      return {
        preview: `Use ${input.path}?`,
        presentation: { title: `Use ${input.path}?`, fields: [] },
        data: {
          sandbox_root: input.path,
          ...(userOnly ? { reviewer: "user" } : {})
        }
      }
    },
    execute: async (input, ctx) => {
      const root = ctx.approval?.data?.["sandbox_root"]
      return `used:${input.path ?? "default"}:${ctx.run.approvalMode}${typeof root === "string" ? `:${root}` : ""}`
    }
  })

export const toolsetFor = (options: {
  readonly mode: ChatApprovalMode
  readonly verdict?: () => Promise<ApprovalReviewVerdict>
  readonly bypass?: boolean
  readonly decision?: "approve" | "ask"
  readonly userOnly?: boolean
  readonly unattended?: boolean
  readonly live?: boolean
  readonly noApproval?: boolean
  readonly pausesConnection?: boolean
}): {
  readonly toolset: Toolset
  readonly reviewed: string[]
  readonly deferred: string[]
  readonly offered: string[]
} => {
  const reviewed: string[] = []
  const deferred: string[] = []
  const offered: string[] = []
  const review: ApprovalReview = async (input) => {
    reviewed.push(input.name)
    return options.verdict === undefined
      ? { verdict: "ask", why: { kind: "judged", reason: "unused" } }
      : options.verdict()
  }
  const toolset = createToolset(
    [
      workspace(
        {
          ...(options.bypass === true ? { approval_bypass: true } : {}),
          ...(options.live === true ? { refuse_unattended: true } : {})
        },
        options.userOnly === true,
        options.pausesConnection === true
      )
    ],
    {
      toJsonSchema: () => ({ type: "object" }),
      approvalGate: makeApprovalGate({
        review,
        policy: gatePolicy(options.mode, {
          deferred,
          offered,
          ...(options.noApproval === undefined ? {} : { noApproval: options.noApproval }),
          ...(options.decision === undefined ? {} : { overrides: { workspace: options.decision } })
        })
      })
    }
  )(
    options.unattended === true
      ? {
          ...run,
          authority: unrecordedAuthority("session-1")
        }
      : run
  )
  return { toolset, reviewed, deferred, offered }
}
