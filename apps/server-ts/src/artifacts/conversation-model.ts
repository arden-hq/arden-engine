import { VISUALIZATION_RUNTIME_VERSION, type ArtifactRole } from "@arden-hq/protocol"
import {
  ArtifactRoleSchema,
  VisualizationKindSchema,
  VisualizationLibrariesSchema,
  VisualizationModeSchema,
  VisualizationRefSchema
} from "@arden-hq/protocol/effect/visualizations"
import { Schema } from "effect"

const MAX_HTML_BYTES = 150_000
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_BYTES: Record<"html" | "image" | "file", number> = {
  html: MAX_HTML_BYTES,
  image: MAX_IMAGE_BYTES,
  file: MAX_FILE_BYTES
}

export const SessionIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
)

export const ScreenshotCaptureSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(4_096)),
  captured_at: Schema.String.check(Schema.isMaxLength(100))
})

export const ManifestSchema = Schema.Struct({
  version: Schema.Literal(2),
  runtime_version: Schema.Literal(VISUALIZATION_RUNTIME_VERSION),
  libraries: VisualizationLibrariesSchema,
  ref: VisualizationRefSchema,
  kind: VisualizationKindSchema,
  title: Schema.String.check(Schema.isMaxLength(200)),
  summary: Schema.String.check(Schema.isMaxLength(500)),
  mode: VisualizationModeSchema,
  media_type: Schema.String,
  filename: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[^/\\]+$/)
  ),
  byte_length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  created_at: Schema.String,
  capture: Schema.optionalKey(ScreenshotCaptureSchema),
  producer_run_id: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
  ),
  operation_key: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
  ),
  role: Schema.optionalKey(ArtifactRoleSchema)
})

export type ConversationArtifactManifest = typeof ManifestSchema.Type

type SpilledTitle = (typeof SPILLED_TITLE)[keyof typeof SPILLED_TITLE]
const isSpilledTitle = (title: string | undefined): title is SpilledTitle =>
  title === SPILLED_TITLE.command || title === SPILLED_TITLE.bash

export const artifactRole = (manifest: ConversationArtifactManifest): ArtifactRole => {
  if (manifest.role !== undefined) return manifest.role
  if (manifest.capture !== undefined) return "working"
  const spilled =
    /^(?:exec_command|bash):/.test(manifest.operation_key ?? "") && isSpilledTitle(manifest.title)
  return spilled ? "working" : "output"
}

const ARTIFACT_SOURCE = { path: "path", bytes: "bytes" } as const

export interface CreateImageArtifactInput {
  readonly sessionId: string
  readonly producerRunId: string
  readonly toolCallId: string
  readonly source:
    | { readonly kind: typeof ARTIFACT_SOURCE.path; readonly path: string }
    | { readonly kind: typeof ARTIFACT_SOURCE.bytes; readonly bytes: Uint8Array }
  readonly capture?: typeof ScreenshotCaptureSchema.Type
  readonly title: string
  readonly summary: string
  readonly mode: "normal" | "wide"
  readonly role: ArtifactRole
}

export interface CreateFileArtifactInput {
  readonly sessionId: string
  readonly producerRunId: string
  readonly operationKey: string
  readonly source:
    | { readonly kind: typeof ARTIFACT_SOURCE.path; readonly path: string }
    | {
        readonly kind: typeof ARTIFACT_SOURCE.bytes
        readonly bytes: Uint8Array
        readonly filename: string
      }
  readonly title: string
  readonly summary: string
  readonly mediaType: string
  readonly role: ArtifactRole
}

export interface ConversationArtifact {
  readonly manifest: ConversationArtifactManifest
  readonly bytes: Uint8Array
}

export const CONVERSATION_ERROR_REASON = {
  invalid: "invalid",
  notFound: "not_found",
  conflict: "conflict",
  corrupt: "corrupt",
  quota: "quota",
  storage: "storage"
} as const

const SPILLED_TITLE = { command: "Command output", bash: "Bash output" } as const

const HTML_ARTIFACT = {
  filename: "content.html",
  mediaType: "text/html; charset=utf-8"
} as const

type HtmlArtifact = {
  readonly filename: typeof HTML_ARTIFACT.filename
  readonly media_type: typeof HTML_ARTIFACT.mediaType
}

export const isHtmlArtifact = (manifest: {
  readonly filename: string
  readonly media_type: string
}): manifest is typeof manifest & HtmlArtifact =>
  manifest.filename === HTML_ARTIFACT.filename && manifest.media_type === HTML_ARTIFACT.mediaType

export class ConversationArtifactError extends Schema.TaggedError<ConversationArtifactError>()(
  "ConversationArtifactError",
  {
    reason: Schema.Literals(Object.values(CONVERSATION_ERROR_REASON)),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}
