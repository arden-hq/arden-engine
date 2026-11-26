import { Option, Schema } from "effect"

export const LOCAL_TARGET_KIND = { file: "file", directory: "directory" } as const
export type LocalTargetKind = (typeof LOCAL_TARGET_KIND)[keyof typeof LOCAL_TARGET_KIND]

export const LocalTargetSchema = Schema.Struct({
  arg: Schema.String,
  kind: Schema.Literals(Object.values(LOCAL_TARGET_KIND))
})
export type LocalTarget = typeof LocalTargetSchema.Type

const decodeLocalTarget = Schema.decodeUnknownOption(LocalTargetSchema)

export const localTargetOf = (
  host: Readonly<Record<string, unknown>> | undefined
): LocalTarget | undefined =>
  host === undefined ? undefined : Option.getOrUndefined(decodeLocalTarget(host["local_target"]))
