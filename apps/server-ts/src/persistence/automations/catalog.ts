import type { RecordedHistoryInput, RecordedHistoryPage, RecordedHistoryError } from "../history.js"
import type {
  Automation,
  AutomationRun,
  AutomationToolScope,
  CreateAutomationInput,
  SystemAutomationSetting,
  UpdateAutomationInput
} from "@arden-hq/protocol/automations"
import { Context, type Effect } from "effect"
import type { JobPurpose } from "../job-classification.js"
import type { AutomationDiagnostics } from "./diagnostics.js"
import type { SystemAutomationSpec } from "./model.js"
import type { AutomationStoreError } from "./store.js"
import type { AutomationId } from "./model.js"
import type { AutomationWriteSource } from "../sqlite/automation-instruction-provenance.js"

export type PromptWriter = "owner" | "agent"

type PromptAuthor = PromptWriter | "unknown"

export interface AutomationDelegation {
  readonly prompt: string
  readonly author: PromptAuthor
}

export interface AutomationInstructionRevision {
  readonly revisionId: number
  readonly automationId: string
  readonly prompt: string
  readonly author: PromptAuthor
  readonly source: AutomationWriteSource | undefined
}

export interface AutomationOriginPolicy {
  readonly purpose: JobPurpose
  readonly handler: string | null
  readonly toolScope: AutomationToolScope
  readonly autoApprove: boolean
  readonly threadId: string | null
}

export interface AutomationCreateTarget {
  readonly type: "existing_chat"
  readonly sessionId: string
}

export class AutomationCatalog extends Context.Service<
  AutomationCatalog,
  {
    readonly history: (
      input: RecordedHistoryInput
    ) => Effect.Effect<RecordedHistoryPage, RecordedHistoryError>
    readonly diagnostics: (
      automationRef?: string
    ) => Effect.Effect<AutomationDiagnostics, AutomationStoreError>
    readonly list: () => Effect.Effect<ReadonlyArray<Automation>, AutomationStoreError>
    readonly get: (
      automationId: AutomationId
    ) => Effect.Effect<Automation | null, AutomationStoreError>
    readonly originPolicy: (
      automationId: AutomationId
    ) => Effect.Effect<AutomationOriginPolicy, AutomationStoreError>
    readonly delegation: (
      automationId: AutomationId
    ) => Effect.Effect<AutomationDelegation | null, AutomationStoreError>
    readonly instructionRevision: (
      revisionId: number
    ) => Effect.Effect<AutomationInstructionRevision | null, AutomationStoreError>
    readonly create: (
      input: CreateAutomationInput & {
        readonly idempotency_key: string
        readonly idempotency_scope: "global"
        readonly target?: AutomationCreateTarget
      },
      writer: PromptWriter,
      source?: AutomationWriteSource
    ) => Effect.Effect<Automation, AutomationStoreError>
    readonly update: (
      automationId: AutomationId,
      input: UpdateAutomationInput,
      writer: PromptWriter,
      source?: AutomationWriteSource
    ) => Effect.Effect<Automation | null, AutomationStoreError>
    readonly resetSystemSetting: (
      automationId: AutomationId,
      setting: SystemAutomationSetting
    ) => Effect.Effect<Automation | null, AutomationStoreError>
    readonly setGeneratedDescription: (
      automationId: AutomationId,
      description: string
    ) => Effect.Effect<Automation | null, AutomationStoreError>
    readonly toggle: (
      automationId: AutomationId
    ) => Effect.Effect<boolean | null, AutomationStoreError>
    readonly delete: (
      automationId: AutomationId
    ) => Effect.Effect<true | null, AutomationStoreError>
    readonly runs: (
      automationId: AutomationId,
      limit: number
    ) => Effect.Effect<ReadonlyArray<AutomationRun> | null, AutomationStoreError>
    readonly seedSystemAutomations: (
      specs: ReadonlyArray<SystemAutomationSpec>
    ) => Effect.Effect<void, AutomationStoreError>
    readonly reconcileSpaceJobs: () => Effect.Effect<void, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/AutomationCatalog") {}
