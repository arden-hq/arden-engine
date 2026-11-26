import type { VaultKeyBroker } from "../credentials/vault-keys.js"
import type { ApprovalReviewSource, TranscriptionSource } from "../models/provider.js"
import type { ModelProvider } from "@arden-hq/loop"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import type { BrowserBroker } from "../browser/service.js"
import type { LocalAccess } from "../http/middleware/local-only.js"
import type { ChatRunner } from "../chat/runner-contract.js"
import type { McpOAuthVault } from "../mcp/vault.js"
import type { GoogleOAuthClient } from "../google/service.js"
import type { ModelHost } from "../models/host.js"
import type { PlanLimitsSource } from "../models/plan-limits.js"
import type { StructuredOutputDialect } from "../models/structured-output.js"
import type { DiagnosticsReporter } from "../runtime/diagnostics.js"

export interface ServerOptions {
  readonly hostname?: string
  readonly port?: number
  readonly version?: string
  readonly idleCompactionAfterMs?: number
  readonly databasePath?: string
  readonly managedOutputRoot?: string
  readonly llamaServer?: string
  readonly sharedSkillRoots?: ReadonlyArray<string>
  readonly commandSandbox?: boolean
  readonly memory?: boolean
  readonly approvalMode?: ApprovalMode
  readonly workFolder?: string
  readonly userFacing?: boolean
  readonly maxRunSteps?: number
  readonly provider?: ModelProvider
  readonly runner?: ChatRunner
  readonly structuredOutputDialect?: StructuredOutputDialect
  readonly approvalReview?: ApprovalReviewSource
  readonly planLimits?: PlanLimitsSource
  readonly transcription?: TranscriptionSource
  readonly modelHost?: ModelHost | Promise<ModelHost>
  readonly refreshModelHost?: () => Promise<ModelHost>
  readonly credentialVault?: McpOAuthVault
  readonly googleOAuthClient?: GoogleOAuthClient | undefined
  readonly diagnostics?: DiagnosticsReporter
  readonly onModelListChange?: () => void
}

export type ModelProviderOptions = Pick<
  ServerOptions,
  | "provider"
  | "modelHost"
  | "refreshModelHost"
  | "structuredOutputDialect"
  | "planLimits"
  | "approvalReview"
  | "transcription"
>

export interface PowerHost {
  readonly keepAwake: (hold: boolean) => void
  readonly onSleep: (listener: (asleep: boolean) => void) => () => void
}

export interface HostedServerOptions extends ServerOptions {
  readonly localAccess?: LocalAccess | undefined
  readonly browserBroker?: BrowserBroker | undefined
  readonly vaultKeys?: VaultKeyBroker | undefined
  readonly power?: PowerHost | undefined
}
