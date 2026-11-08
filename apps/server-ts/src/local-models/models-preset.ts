import path from "node:path"

import type { ModelManifest } from "./manifest.js"

export interface PresetModel {
  readonly manifest: ModelManifest
  readonly directory: string
}

const DECISION_SLEEP_SECONDS = 300
const PARALLEL_SLOTS = 2
const EMBEDDING_BATCH_TOKENS = 2048
const DECISION_CACHE_MIB = 512
const DECISION_BATCH_TOKENS = 8192
const DECISION_UBATCH_TOKENS = 512

const fileOf = (model: PresetModel, role: "weights" | "projector") => {
  const file = model.manifest.files.find((entry) => entry.role === role)
  return file === undefined ? undefined : path.join(model.directory, file.path)
}

const modelLines = (model: PresetModel): ReadonlyArray<string> => {
  const { manifest } = model
  const common = [
    `model = ${fileOf(model, "weights")}`,
    `parallel = ${PARALLEL_SLOTS}`,
    "load-on-startup = false"
  ]
  if (manifest.kind === "embedding") {
    return [
      ...common,
      "embeddings = true",
      `pooling = ${manifest.pooling}`,
      `ctx-size = ${EMBEDDING_BATCH_TOKENS}`,
      `batch-size = ${EMBEDDING_BATCH_TOKENS}`,
      `ubatch-size = ${EMBEDDING_BATCH_TOKENS}`
    ]
  }
  const projector = fileOf(model, "projector")
  return [
    ...common,
    ...(projector === undefined ? [] : [`mmproj = ${projector}`]),
    `ctx-size = ${manifest.contextTokens}`,
    "kv-unified = true",
    `batch-size = ${Math.min(manifest.contextTokens, DECISION_BATCH_TOKENS)}`,
    `ubatch-size = ${Math.min(manifest.contextTokens, DECISION_UBATCH_TOKENS)}`,
    `cache-ram = ${DECISION_CACHE_MIB}`,
    "flash-attn = off",
    "reasoning = off",
    `sleep-idle-seconds = ${DECISION_SLEEP_SECONDS}`
  ]
}

/**
 * The router's `--models-preset` INI (llama.cpp tools/server README, "Model
 * presets"): one section per installed model, named by its manifest id, which
 * is what requests send as `model`. `fit = off` skips the ~9 s memory-fit pass
 * at every child start. Paths are absolute.
 */
export const renderModelsPreset = (models: ReadonlyArray<PresetModel>): string =>
  [
    "version = 1",
    "",
    "[*]",
    "fit = off",
    ...models.flatMap((model) => ["", `[${model.manifest.id}]`, ...modelLines(model)]),
    ""
  ].join("\n")
