import {
  ARTIFACT_OPERATION,
  ARTIFACT_PRODUCER,
  VISUALIZATION_KIND
} from "@arden-hq/protocol/visualizations"
import type { VisualizationManifestResponseSchema } from "@arden-hq/protocol/effect/visualizations"
import { artifactRole, type ConversationArtifactManifest } from "../../artifacts/conversation.js"

type ManifestResponse = typeof VisualizationManifestResponseSchema.Type

export const NO_TURNS: ReadonlyMap<string, string> = new Map()

const producerOf = (
  runId: string | undefined,
  turns: ReadonlyMap<string, string>
): ManifestResponse["producer"] => {
  if (runId === undefined) return { kind: ARTIFACT_PRODUCER.unrecorded }
  const turnId = turns.get(runId)
  if (turnId === undefined) return { kind: ARTIFACT_PRODUCER.run, run_id: runId }
  return { kind: ARTIFACT_PRODUCER.turn, run_id: runId, turn_id: turnId }
}

export const visualizationToWire = (
  manifest: ConversationArtifactManifest,
  turns: ReadonlyMap<string, string>
): ManifestResponse => {
  const facts = {
    runtime_version: manifest.runtime_version,
    libraries: manifest.libraries,
    ref: manifest.ref,
    title: manifest.title,
    summary: manifest.summary,
    mode: manifest.mode,
    media_type: manifest.media_type,
    byte_length: manifest.byte_length,
    created_at: manifest.created_at,
    producer: producerOf(manifest.producer_run_id, turns),
    operation:
      manifest.operation_key === undefined
        ? { kind: ARTIFACT_OPERATION.unkeyed }
        : { kind: ARTIFACT_OPERATION.keyed, key: manifest.operation_key },
    role: artifactRole(manifest)
  }
  return manifest.kind === VISUALIZATION_KIND.file
    ? { ...facts, kind: manifest.kind, filename: manifest.filename }
    : { ...facts, kind: manifest.kind }
}
