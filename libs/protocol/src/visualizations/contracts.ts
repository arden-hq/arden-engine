export const VISUALIZATION_RUNTIME_VERSION = 2 as const

export const VISUALIZATION_LIBRARIES = ["d3"] as const

export type VisualizationLibrary = (typeof VISUALIZATION_LIBRARIES)[number]

export const VISUALIZATION_KIND = { html: "html", image: "image", file: "file" } as const

export type VisualizationKind = "html" | "image" | "file"

export type VisualizationMode = "normal" | "wide"

/** What an artifact is for: an `output` was made for the owner (a saved
 *  file, a visualization); `working` material only served a step (a
 *  command's spilled output, a browser screenshot). */
export const ARTIFACT_ROLES = ["output", "working"] as const

export type ArtifactRole = (typeof ARTIFACT_ROLES)[number]

export const ARTIFACT_PRODUCER = { unrecorded: "unrecorded", run: "run", turn: "turn" } as const

export type ArtifactProducer =
  | { readonly kind: typeof ARTIFACT_PRODUCER.unrecorded }
  | { readonly kind: typeof ARTIFACT_PRODUCER.run; readonly runId: string }
  | {
      readonly kind: typeof ARTIFACT_PRODUCER.turn
      readonly runId: string
      readonly turnId: string
    }

export const ARTIFACT_OPERATION = { unkeyed: "unkeyed", keyed: "keyed" } as const

export type ArtifactOperation =
  | { readonly kind: typeof ARTIFACT_OPERATION.unkeyed }
  | { readonly kind: typeof ARTIFACT_OPERATION.keyed; readonly key: string }

interface ManifestFacts {
  readonly runtimeVersion: typeof VISUALIZATION_RUNTIME_VERSION
  readonly libraries: ReadonlyArray<VisualizationLibrary>
  readonly ref: string
  readonly title: string
  readonly summary: string
  readonly mode: VisualizationMode
  readonly mediaType: string
  readonly byteLength: number
  readonly createdAt: string
  readonly producer: ArtifactProducer
  readonly operation: ArtifactOperation
  readonly role: ArtifactRole
}

export type VisualizationManifest =
  | (ManifestFacts & { readonly kind: "html" | "image" })
  | (ManifestFacts & { readonly kind: "file"; readonly filename: string })
