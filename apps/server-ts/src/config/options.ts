import type { ApprovalReviewSource, TranscriptionSource } from "../models/provider.js"
import type { ModelProvider } from "@arden-hq/loop"
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
  /** Idle-compaction delay after the last model response completes.
   *  Defaults to 30 seconds; zero disables idle compaction. */
  readonly idleCompactionAfterMs?: number
  /** SQLite file path; Arden's other files live in its directory. Omit (or pass
   *  `":memory:"`) for an isolated in-memory server whose files live in a
   *  temporary directory removed on stop. */
  readonly databasePath?: string
  /** Required for an in-memory server (else `invalid_options`); a file-backed
   *  server keeps managed outputs beside the database and ignores it. */
  readonly managedOutputRoot?: string
  /** The staged llama-server for downloaded local models. Omit when the build ships none. */
  readonly llamaServer?: string
  /** Read-only Skill roots shared with other agents, scanned after Arden's own.
   *  Defaults to `~/.agents/skills` for a file-backed server; pass `[]` to isolate. */
  readonly sharedSkillRoots?: ReadonlyArray<string>
  /** The model provider. It drives the built-in Loop runner and every
   *  helper-model feature: context compaction, structured completion, Session
   *  naming, letter subjects and `has_providers`. Omit for a server without a
   *  model: Chat then answers `unavailable`. */
  readonly provider?: ModelProvider
  /** Advanced host runner that replaces only the built-in Chat loop. It may be
   *  set with or without `provider`; helper-model features follow `provider`. */
  readonly runner?: ChatRunner
  /** The schema dialect `provider`'s native structured output accepts.
   *  Defaults to `openai` (the Responses API strict subset). */
  readonly structuredOutputDialect?: StructuredOutputDialect
  /** Dedicated approval transport; omit to use the Helper model. */
  readonly approvalReview?: ApprovalReviewSource
  /** How much of `provider`'s plan is used. Omit when the route has no plan meter. */
  readonly planLimits?: PlanLimitsSource
  /** Dictation on the provider's account. Omit when the route has none. */
  readonly transcription?: TranscriptionSource
  /** Credential-free catalog and defaults supplied by the bundled host. A
   *  catalog is validated before start (else `invalid_options`) and served
   *  from the first request; a promise lets the provider discover it while
   *  storage and HTTP start. */
  readonly modelHost?: ModelHost | Promise<ModelHost>
  readonly refreshModelHost?: () => Promise<ModelHost>
  /** Secure OAuth credential owner supplied by the bundled desktop host. */
  readonly credentialVault?: McpOAuthVault
  /** App-owned Google Desktop OAuth client. Never supplied by the renderer. */
  readonly googleOAuthClient?: GoogleOAuthClient | undefined
  /** Host-owned Google transport. Omit to use the default fetch. Never supplied by the renderer. */
  /** Host-owned startup milestones and structured operational events. Never exposed over HTTP. */
  readonly diagnostics?: DiagnosticsReporter
}

/** The model provider a host configures, at start or when it swaps providers. */
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
  readonly power?: PowerHost | undefined
}
