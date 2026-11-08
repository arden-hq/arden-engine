import { Schema } from "effect"

import { type ModelManifest, ModelManifestSchema } from "./manifest.js"

const huggingFace = (repository: string, revision: string, file: string) =>
  `https://huggingface.co/${repository}/resolve/${revision}/${file}`
const huggingFacePage = (repository: string, revision: string, file: string) =>
  `https://huggingface.co/${repository}/blob/${revision}/${file}`

export const GRANITE_GGUF_ID = "granite-embedding-97m-multilingual-r2-q8"
const D1_ID = "d1-3b-q4"

const GRANITE_SOURCE_REPOSITORY = "ibm-granite/granite-embedding-97m-multilingual-r2"
const GRANITE_SOURCE_REVISION = "835ad14087e140460703cf0fae09f97d469d65c2"
const GRANITE_GGUF_REPOSITORY = "mykor/granite-embedding-97m-multilingual-r2-GGUF"
const GRANITE_GGUF_REVISION = "45ce642d3fab2033d167ec09641a159010f7d9d9"
const D1_GGUF_REPOSITORY = "LiquidAI/d1-3B-GGUF"
const D1_GGUF_REVISION = "bb1e436ea78eb96a3f1acb6da865f70c2fbeb563"

const entries = [
  {
    kind: "embedding",
    id: GRANITE_GGUF_ID,
    name: "Granite 97M",
    // The repositories carry no LICENSE file; the model card states Apache-2.0.
    license: {
      name: "Apache-2.0",
      url: huggingFacePage(GRANITE_SOURCE_REPOSITORY, GRANITE_SOURCE_REVISION, "README.md")
    },
    source: { repository: GRANITE_SOURCE_REPOSITORY, revision: GRANITE_SOURCE_REVISION },
    input: "text",
    contextTokens: 2048,
    files: [
      {
        role: "weights",
        path: "granite-embedding-97M-multilingual-r2-Q8_0.gguf",
        url: huggingFace(
          GRANITE_GGUF_REPOSITORY,
          GRANITE_GGUF_REVISION,
          "granite-embedding-97M-multilingual-r2-Q8_0.gguf"
        ),
        bytes: 115_061_088,
        sha256: "25155b89638e501ac33495fa278d551d7545e1e2f62722a499bba1f064c080f2"
      }
    ],
    dimensions: 384,
    pooling: "cls",
    prefixes: { query: "", document: "" }
  },
  {
    kind: "decision",
    id: D1_ID,
    name: "Liquid d1 3B",
    // Free, commercial use included, while the user's company earns under USD 10 M a year (§5).
    license: {
      name: "LFM Open License",
      url: huggingFacePage(D1_GGUF_REPOSITORY, D1_GGUF_REVISION, "LICENSE")
    },
    source: {
      repository: "LiquidAI/d1-3B",
      revision: "051bcc464b01b9f92942b364d9586b0ef5912432"
    },
    input: "text+image",
    contextTokens: 16_384,
    files: [
      {
        role: "weights",
        path: "d1-3B-Q4_K_M.gguf",
        url: huggingFace(D1_GGUF_REPOSITORY, D1_GGUF_REVISION, "d1-3B-Q4_K_M.gguf"),
        bytes: 1_674_456_672,
        sha256: "16aff27ea2eefdc32b9897f43854a5d3170c1dc8dccb9c756905af30a4e22402"
      },
      {
        role: "projector",
        path: "mmproj-d1-3B-Q8_0.gguf",
        url: huggingFace(D1_GGUF_REPOSITORY, D1_GGUF_REVISION, "mmproj-d1-3B-Q8_0.gguf"),
        bytes: 583_109_728,
        sha256: "2505920ce464b7c54acd8b7b74a931c0c671f06d0c8833760b2fbceeb253e92a"
      },
      {
        role: "license",
        path: "LICENSE",
        url: huggingFace(D1_GGUF_REPOSITORY, D1_GGUF_REVISION, "LICENSE"),
        bytes: 10_574,
        sha256: "4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c"
      }
    ],
    readout: {
      type: "native",
      statePrompt: { before: "<|startoftext|><|im_start|>user\n", after: "\n\n\nQUESTION:\n" }
    }
  }
]

export const LOCAL_MODEL_CATALOG: ReadonlyArray<ModelManifest> = Schema.decodeUnknownSync(
  Schema.Array(ModelManifestSchema)
)(entries)

export type EmbeddingManifest = Extract<ModelManifest, { kind: "embedding" }>
export type DecisionManifest = Extract<ModelManifest, { kind: "decision" }>

export const LOCAL_EMBEDDING_MODELS = LOCAL_MODEL_CATALOG.filter(
  (manifest): manifest is EmbeddingManifest => manifest.kind === "embedding"
)
export const LOCAL_DECISION_MODELS = LOCAL_MODEL_CATALOG.filter(
  (manifest): manifest is DecisionManifest => manifest.kind === "decision"
)
