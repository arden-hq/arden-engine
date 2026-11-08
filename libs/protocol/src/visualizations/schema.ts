import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"
import {
  ARTIFACT_ROLES,
  VISUALIZATION_LIBRARIES,
  VISUALIZATION_RUNTIME_VERSION,
  type VisualizationManifest
} from "./contracts.js"

/** `viz-…` for rendered HTML, `file-…` for a stored file; 128 random bits in hex. */
export const VisualizationRefSchema = Schema.String.check(
  Schema.isPattern(/^(?:viz|file)-[a-f0-9]{32}$/)
)

export const VisualizationKindSchema = Schema.Literals(["html", "image", "file"] as const)

export const VisualizationModeSchema = Schema.Literals(["normal", "wide"] as const)

export const ArtifactRoleSchema = Schema.Literals(ARTIFACT_ROLES)

/** Each supported library at most once. */
export const VisualizationLibrariesSchema = Schema.Array(
  Schema.Literals(VISUALIZATION_LIBRARIES)
).check(Schema.isMaxLength(VISUALIZATION_LIBRARIES.length), Schema.isUnique())

/** `GET /sessions/:sessionId/visualizations[/:artifactRef]` item. */
export const VisualizationManifestResponseSchema = Schema.Struct({
  runtime_version: Schema.Literal(VISUALIZATION_RUNTIME_VERSION),
  libraries: VisualizationLibrariesSchema,
  ref: VisualizationRefSchema,
  kind: VisualizationKindSchema,
  title: Schema.String,
  summary: Schema.String,
  mode: VisualizationModeSchema,
  media_type: Schema.String,
  byte_length: NonNegativeIntSchema,
  filename: Schema.optionalKey(Schema.String),
  /** When the artifact was stored (ISO 8601); absent from a server older
   *  than the field, which a client must still read. */
  created_at: Schema.optionalKey(Schema.String),
  producer_run_id: Schema.optionalKey(Schema.String),
  operation_key: Schema.optionalKey(Schema.String),
  /** The chat turn it was made in; absent for one saved without its run. */
  turn_id: Schema.optionalKey(Schema.String),
  /** What it is for; absent from a server older than the field, which read
   *  every artifact as an output. */
  role: Schema.optionalKey(ArtifactRoleSchema)
})

export const VisualizationListResponseSchema = Schema.Array(VisualizationManifestResponseSchema)

export const toVisualizationManifest = (
  manifest: typeof VisualizationManifestResponseSchema.Type
): VisualizationManifest => ({
  runtimeVersion: manifest.runtime_version,
  libraries: manifest.libraries,
  ref: manifest.ref,
  kind: manifest.kind,
  title: manifest.title,
  summary: manifest.summary,
  mode: manifest.mode,
  mediaType: manifest.media_type,
  byteLength: manifest.byte_length,
  role: manifest.role ?? "output",
  ...(manifest.created_at === undefined ? {} : { createdAt: manifest.created_at }),
  ...(manifest.filename === undefined ? {} : { filename: manifest.filename }),
  ...(manifest.producer_run_id === undefined ? {} : { producerRunId: manifest.producer_run_id }),
  ...(manifest.operation_key === undefined ? {} : { operationKey: manifest.operation_key }),
  ...(manifest.turn_id === undefined ? {} : { turnId: manifest.turn_id })
})
