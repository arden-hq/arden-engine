import { Schema } from "effect"

import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"
import type { CliTool, CliToolSkill, CliToolsReport } from "./contracts.js"

const boundedNonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const CliToolSkillSchema: Schema.Codec<CliToolSkill> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("built_in"), name: boundedNonEmpty(128) }),
  Schema.Struct({
    kind: Schema.Literal("installed"),
    name: boundedNonEmpty(128),
    enabled: Schema.Boolean
  }),
  Schema.Struct({ kind: Schema.Literal("none") })
])

const CliToolSchema: Schema.Codec<CliTool> = withExtras({
  id: boundedNonEmpty(64),
  name: boundedNonEmpty(128),
  description: Schema.String.check(Schema.isMaxLength(512)),
  command: boundedNonEmpty(64),
  path: boundedNonEmpty(4096),
  version: Schema.NullOr(boundedNonEmpty(64)),
  sign_in: Schema.Literals(["signed_in", "signed_out", "unknown"] as const),
  login_command: Schema.NullOr(boundedNonEmpty(256)),
  skill: CliToolSkillSchema
})

export const CliToolsReportSchema: Schema.Codec<CliToolsReport> = withExtras({
  tools: Schema.Array(CliToolSchema),
  path_source: Schema.Literals(["login_shell", "process"] as const),
  checked_at: IsoDateTimeStringSchema
})
