import { Schema } from "effect"

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0))

const SAFE_RELATIVE_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u
const PINNED_HUGGING_FACE_URL =
  /^https:\/\/huggingface\.co\/[^\s/]+\/[^\s/]+\/resolve\/[0-9a-f]{40}\/\S+$/u
const PINNED_HUGGING_FACE_PAGE =
  /^https:\/\/huggingface\.co\/[^\s/]+\/[^\s/]+\/blob\/[0-9a-f]{40}\/\S+$/u

const ModelFileSchema = Schema.Struct({
  /**
   * weights — the GGUF model; projector — the multimodal projector (llama-server
   * --mmproj); license — the licence text, kept beside the weights when the
   * licence asks that its copy travel with them (LFM Open License §4).
   */
  role: Schema.Literals(["weights", "projector", "license"]),
  path: Schema.String.check(Schema.isPattern(SAFE_RELATIVE_PATH)),
  url: Schema.String.check(Schema.isPattern(PINNED_HUGGING_FACE_URL)),
  bytes: PositiveIntSchema,
  sha256: Sha256Schema
})

const ReadoutSchema = Schema.Struct({
  type: Schema.Literal("native"),
  statePrompt: Schema.Struct({ before: Schema.String, after: Schema.String })
})

const CommonFields = {
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  name: Schema.String.check(Schema.isMinLength(1)),
  license: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
    url: Schema.String.check(Schema.isPattern(PINNED_HUGGING_FACE_PAGE))
  }),
  source: Schema.Struct({
    repository: Schema.String.check(Schema.isMinLength(1)),
    revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u))
  }),
  input: Schema.Literals(["text", "text+image"]),
  contextTokens: PositiveIntSchema,
  files: Schema.Array(ModelFileSchema).check(Schema.isMinLength(1))
}

const ModelManifestUnionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("embedding"),
    ...CommonFields,
    dimensions: PositiveIntSchema,
    pooling: Schema.Literals(["cls", "mean", "last"]),
    prefixes: Schema.Struct({ query: Schema.String, document: Schema.String })
  }),
  Schema.Struct({
    kind: Schema.Literal("decision"),
    ...CommonFields,
    readout: ReadoutSchema
  })
])

const fileIssue = (manifest: (typeof ModelManifestUnionSchema)["Type"]): string | undefined => {
  const roles = manifest.files.map((file) => file.role)
  const paths = manifest.files.map((file) => file.path)
  const projectors = roles.filter((role) => role === "projector").length
  if (roles.filter((role) => role === "weights").length !== 1)
    return "needs exactly one weights file"
  if (roles.filter((role) => role === "license").length > 1) return "at most one license file"
  if (new Set(paths).size !== paths.length) return "file paths must be distinct"
  if (manifest.input === "text+image" && projectors !== 1) {
    return "text+image input needs exactly one projector file"
  }
  if (manifest.input === "text" && projectors !== 0)
    return "a projector file needs text+image input"
  return undefined
}

export const ModelManifestSchema = ModelManifestUnionSchema.check(
  Schema.makeFilter((manifest) => {
    const issue = fileIssue(manifest)
    return issue === undefined ? undefined : { path: ["files"], issue }
  })
)

export type ModelManifest = (typeof ModelManifestSchema)["Type"]
