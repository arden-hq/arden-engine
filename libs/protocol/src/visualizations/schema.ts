import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"
import {
  ARTIFACT_PRODUCER,
  ARTIFACT_ROLES,
  VISUALIZATION_KIND,
  VISUALIZATION_LIBRARIES,
  VISUALIZATION_RUNTIME_VERSION,
  type ArtifactProducer,
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

const ManifestFacts = {
  runtime_version: Schema.Literal(VISUALIZATION_RUNTIME_VERSION),
  libraries: VisualizationLibrariesSchema,
  ref: VisualizationRefSchema,
  title: Schema.String,
  summary: Schema.String,
  mode: VisualizationModeSchema,
  media_type: Schema.String,
  byte_length: NonNegativeIntSchema,
  created_at: Schema.String,
  producer: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unrecorded") }),
    Schema.Struct({ kind: Schema.Literal("run"), run_id: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("turn"), run_id: Schema.String, turn_id: Schema.String })
  ]),
  operation: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unkeyed") }),
    Schema.Struct({ kind: Schema.Literal("keyed"), key: Schema.String })
  ]),
  role: ArtifactRoleSchema
}

export const VisualizationManifestResponseSchema = Schema.Union([
  Schema.Struct({ ...ManifestFacts, kind: Schema.Literals(["html", "image"] as const) }),
  Schema.Struct({
    ...ManifestFacts,
    kind: Schema.Literal("file"),
    filename: Schema.String
  })
])

export const VisualizationListResponseSchema = Schema.Array(VisualizationManifestResponseSchema)

const producerOf = (
  producer: (typeof VisualizationManifestResponseSchema.Type)["producer"]
): ArtifactProducer => {
  if (producer.kind === ARTIFACT_PRODUCER.unrecorded) return producer
  if (producer.kind === ARTIFACT_PRODUCER.run)
    return { kind: producer.kind, runId: producer.run_id }
  return { kind: producer.kind, runId: producer.run_id, turnId: producer.turn_id }
}

export const toVisualizationManifest = (
  manifest: typeof VisualizationManifestResponseSchema.Type
): VisualizationManifest => {
  const facts = {
    runtimeVersion: manifest.runtime_version,
    libraries: manifest.libraries,
    ref: manifest.ref,
    title: manifest.title,
    summary: manifest.summary,
    mode: manifest.mode,
    mediaType: manifest.media_type,
    byteLength: manifest.byte_length,
    createdAt: manifest.created_at,
    producer: producerOf(manifest.producer),
    operation: manifest.operation,
    role: manifest.role
  }
  return manifest.kind === VISUALIZATION_KIND.file
    ? { ...facts, kind: manifest.kind, filename: manifest.filename }
    : { ...facts, kind: manifest.kind }
}
