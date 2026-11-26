import { Schema } from "effect"

import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"
import {
  CLI_TOOL_LOGIN,
  CLI_TOOL_SIGN_IN,
  CLI_TOOL_SKILL,
  CLI_TOOL_VERSION,
  CLI_TOOLS_PATH_SOURCE,
  type CliTool,
  type CliToolSkill,
  type CliToolsReport
} from "./contracts.js"

const boundedNonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const CliToolSkillSchema: Schema.Codec<CliToolSkill> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CLI_TOOL_SKILL.builtIn), name: boundedNonEmpty(128) }),
  Schema.Struct({
    kind: Schema.Literal(CLI_TOOL_SKILL.installed),
    name: boundedNonEmpty(128),
    enabled: Schema.Boolean
  }),
  Schema.Struct({ kind: Schema.Literal(CLI_TOOL_SKILL.none) })
])

const CliToolSchema: Schema.Codec<CliTool> = withExtras({
  id: boundedNonEmpty(64),
  name: boundedNonEmpty(128),
  description: Schema.String.check(Schema.isMaxLength(512)),
  command: boundedNonEmpty(64),
  path: boundedNonEmpty(4096),
  version: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(CLI_TOOL_VERSION.reported), text: boundedNonEmpty(64) }),
    Schema.Struct({ kind: Schema.Literal(CLI_TOOL_VERSION.unreported) })
  ]),
  sign_in: Schema.Literals(Object.values(CLI_TOOL_SIGN_IN)),
  login: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(CLI_TOOL_LOGIN.command), command: boundedNonEmpty(256) }),
    Schema.Struct({ kind: Schema.Literal(CLI_TOOL_LOGIN.none) })
  ]),
  skill: CliToolSkillSchema
})

export const CliToolsReportSchema: Schema.Codec<CliToolsReport> = withExtras({
  tools: Schema.Array(CliToolSchema),
  path_source: Schema.Literals(Object.values(CLI_TOOLS_PATH_SOURCE)),
  checked_at: IsoDateTimeStringSchema
})
