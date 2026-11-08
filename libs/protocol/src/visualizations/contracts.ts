export const VISUALIZATION_RUNTIME_VERSION = 2 as const

export const VISUALIZATION_LIBRARIES = ["d3"] as const

export type VisualizationLibrary = (typeof VISUALIZATION_LIBRARIES)[number]

export type VisualizationKind = "html" | "image" | "file"

export type VisualizationMode = "normal" | "wide"

/** What an artifact is for: an `output` was made for the owner (a saved
 *  file, a visualization); `working` material only served a step (a
 *  command's spilled output, a browser screenshot). */
export const ARTIFACT_ROLES = ["output", "working"] as const

export type ArtifactRole = (typeof ARTIFACT_ROLES)[number]

/** One stored visualization or file artifact of a session, as the client reads it. */
export interface VisualizationManifest {
  readonly runtimeVersion: typeof VISUALIZATION_RUNTIME_VERSION
  readonly libraries: ReadonlyArray<VisualizationLibrary>
  readonly ref: string
  readonly kind: VisualizationKind
  readonly title: string
  readonly summary: string
  readonly mode: VisualizationMode
  readonly mediaType: string
  readonly byteLength: number
  readonly filename?: string
  /** When it was stored (ISO 8601). */
  readonly createdAt?: string
  readonly producerRunId?: string
  readonly operationKey?: string
  /** The chat turn it was made in (an agent's output: the turn that started
   *  the agent). Absent for one saved without its run. */
  readonly turnId?: string
  readonly role: ArtifactRole
}
