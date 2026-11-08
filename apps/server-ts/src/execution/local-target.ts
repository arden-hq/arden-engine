import { Option, Schema } from "effect"

export const LocalTargetSchema = Schema.Struct({
  arg: Schema.String,
  kind: Schema.Literals(["file", "directory"])
})
export type LocalTarget = typeof LocalTargetSchema.Type

const decodeLocalTarget = Schema.decodeUnknownOption(LocalTargetSchema)

export const localTargetOf = (
  host: Readonly<Record<string, unknown>> | undefined
): LocalTarget | undefined =>
  host === undefined ? undefined : Option.getOrUndefined(decodeLocalTarget(host["local_target"]))
