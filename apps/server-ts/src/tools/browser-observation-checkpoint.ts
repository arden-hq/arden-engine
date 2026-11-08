import type { ToolResult } from "@arden-hq/loop"
import { Schema } from "effect"
import {
  BrowserObservationCheckpointSchema,
  type BrowserObservationCheckpoint
} from "../browser/observation.js"
import type { BrowserObservationRegistry } from "./run-context.js"
import type { ScriptFields } from "../workflows/runtime/contract.js"

const ReportedTabSchema = Schema.Struct({ tab: Schema.Struct({ tab_ref: Schema.String }) })
const ReportedSnapshotSchema = Schema.Struct({ snapshot_ref: Schema.String })

export const checkpointBrowserObservation = (input: {
  readonly observations: BrowserObservationRegistry
  readonly args: Readonly<Record<string, unknown>>
  readonly result: ToolResult
  readonly fields: ScriptFields | undefined
  readonly previousRef: string | undefined
}): BrowserObservationCheckpoint | undefined => {
  const reported = Schema.decodeUnknownOption(ReportedTabSchema)(input.result.data)
  const returnedTab = reported._tag === "Some" ? reported.value.tab.tab_ref : undefined
  const tabRef = typeof input.args["tab_ref"] === "string" ? input.args["tab_ref"] : returnedTab
  if (tabRef === undefined) return undefined
  const page = Schema.decodeUnknownOption(ReportedSnapshotSchema)(input.fields?.["page"])
  const direct = Schema.decodeUnknownOption(ReportedSnapshotSchema)(input.result.data)
  const directRef = direct._tag === "Some" ? direct.value.snapshot_ref : undefined
  const pageRef = page._tag === "Some" ? page.value.snapshot_ref : undefined
  const ref = directRef ?? pageRef ?? input.previousRef
  const checkpoint = input.observations.checkpoint(tabRef)
  return checkpoint.snapshot !== null && checkpoint.snapshot.ref !== ref
    ? { ...checkpoint, snapshot: null }
    : checkpoint
}

export const restoreBrowserObservation = (
  observations: BrowserObservationRegistry,
  result: ToolResult
): void => {
  const saved = Schema.decodeUnknownOption(BrowserObservationCheckpointSchema)(
    result.host?.["browser_observation"]
  )
  if (saved._tag === "Some") observations.restore(saved.value)
}
