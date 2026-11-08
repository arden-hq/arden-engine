import { Schema } from "effect"

export const COMMAND_TOOL = "exec_command"

export const CommandPolicyRuleSchema = Schema.Struct({
  executable_path: Schema.NonEmptyString,
  argument_prefix: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(8)),
  display_prefix: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
})
const CommandGrantOfferSchema = Schema.Struct({
  rules: Schema.Array(CommandPolicyRuleSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16))
})
export const CommandGrantApprovalDataSchema = Schema.Struct({
  command_grant: CommandGrantOfferSchema
})
export const WordsGrantApprovalDataSchema = Schema.Struct({
  words_grant: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
  })
})
export type CommandPolicyRule = typeof CommandPolicyRuleSchema.Type
export type CommandGrantOffer = typeof CommandGrantOfferSchema.Type

export const commandWords = (executable: string, argumentPrefix: ReadonlyArray<string>): string =>
  [executable.slice(executable.lastIndexOf("/") + 1), ...argumentPrefix].join(" ")

export const commandDisplayPrefix = (
  executable: string,
  argumentPrefix: ReadonlyArray<string>
): string => `${commandWords(executable, argumentPrefix)} …`
