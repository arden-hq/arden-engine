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
  /** False runs every shell command on the host, whatever access the model
   *  asks for. For a server inside a throwaway container, where the container
   *  is the sandbox. Defaults to true. */
  readonly commandSandbox?: boolean
  /** False keeps Memory recall and related chats out of every prompt, in every
   *  chat and sub-agent. A chat's own context selection still applies on top.
   *  Defaults to true. */
  readonly memory?: boolean
  /** Every message runs in this approval mode, whatever the request names.
   *  For a server with nobody to answer a card. Omit to let each message and
   *  chat decide, as in the app. */
  readonly approvalMode?: ApprovalMode
  /** The folder this server's chats work in. Its AGENTS.md is shown to the
   *  model from its first step. It grants no access: a permission rule does
   *  that. */
  readonly workFolder?: string
  /** False when no person follows this server's chats as they run, as on a
   *  server a program drives. A chat then works on its request directly, as
   *  a worker does, instead of keeping itself free by handing work to a
   *  child. Defaults to true. */
  readonly userFacing?: boolean
  /** Most model steps one Chat run may take. Near the limit the run is told
   *  how many are left, and its last step has no tools so it ends in a reply.
   *  Defaults to 200. */
  readonly maxRunSteps?: number
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
  /** Called when the server itself changed the model list: a model server was
   *  saved, edited or removed, or listed other models when asked again. The
   *  desktop daemon tells the app as it does after a ChatGPT sign-in. */
  readonly onModelListChange?: () => void
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
  /** The desktop's Vault: key names, fake values and the output scrub, never a value. */
  readonly vaultKeys?: VaultKeyBroker | undefined
  readonly power?: PowerHost | undefined
}
