import { Schema } from "effect"
import { VisualizationManifestResponseSchema } from "@arden-hq/protocol/effect/visualizations"
import { expect, it } from "vitest"
import { NO_TURNS, visualizationToWire } from "../src/http/sessions/visualization-wire.js"

const base = {
  version: 2,
  runtime_version: 2,
  libraries: [],
  title: "Report",
  summary: "",
  mode: "normal",
  byte_length: 3,
  sha256: "a".repeat(64),
  created_at: "2026-11-24T00:00:00.000Z"
} as const

it("names the run and turn that made an artifact, and a file's name and operation", () => {
  const image = visualizationToWire(
    {
      ...base,
      ref: `viz-${"b".repeat(32)}`,
      kind: "image",
      media_type: "image/png",
      filename: "image.png",
      producer_run_id: "run-1"
    },
    new Map([["run-1", "turn-1"]])
  )
  expect(image).toMatchObject({
    kind: "image",
    producer: { kind: "turn", run_id: "run-1", turn_id: "turn-1" },
    operation: { kind: "unkeyed" },
    role: "output"
  })
  expect("filename" in image).toBe(false)
  const file = visualizationToWire(
    {
      ...base,
      ref: `file-${"c".repeat(32)}`,
      kind: "file",
      media_type: "text/plain",
      filename: "notes.txt",
      producer_run_id: "run-2",
      operation_key: "files_write:1"
    },
    NO_TURNS
  )
  expect(file).toMatchObject({
    kind: "file",
    filename: "notes.txt",
    producer: { kind: "run", run_id: "run-2" },
    operation: { kind: "keyed", key: "files_write:1" }
  })
  for (const manifest of [image, file])
    expect(Schema.decodeUnknownSync(VisualizationManifestResponseSchema)(manifest)).toEqual(
      manifest
    )
})
