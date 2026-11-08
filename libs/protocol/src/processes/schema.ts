import { Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"
import type { MonitoredProcess, ProcessOwner, ProcessSnapshot, ProcessOutput } from "./contracts.js"

const OwnerSchema: Schema.Codec<ProcessOwner> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("command"),
    terminal_id: Schema.Int,
    session_id: Schema.NonEmptyString,
    run_id: Schema.NonEmptyString,
    name: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    root_key: Schema.NonEmptyString
  }),
  Schema.Struct({
    kind: Schema.Literal("browser"),
    session_id: Schema.NonEmptyString,
    name: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("shared"), name: Schema.NonEmptyString })
])
const ProcessSchema: Schema.Codec<MonitoredProcess> = withExtras({
  key: Schema.NonEmptyString,
  pid: Schema.Int,
  parent_pid: Schema.Int,
  name: Schema.String,
  owner: OwnerSchema,
  cpu_percent: Schema.NullOr(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
  ),
  memory_bytes: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  can_stop: Schema.Boolean
})
export const ProcessSnapshotSchema: Schema.Codec<ProcessSnapshot> = withExtras({
  state: Schema.Literals(["ready", "unavailable"]),
  sampled_at: IsoDateTimeStringSchema,
  host: Schema.String,
  cpu_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  processes: Schema.Array(ProcessSchema),
  detail: Schema.NullOr(Schema.String)
})
export const StopProcessRequestSchema = Schema.Struct({ key: Schema.NonEmptyString })
export const ProcessOutputSchema: Schema.Codec<ProcessOutput> = withExtras({
  output: Schema.String,
  state: Schema.Literals(["running", "exited", "unavailable"])
})
export const ProcessActionSchema = Schema.Struct({ ok: Schema.Boolean })
