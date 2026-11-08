import type { NewPermissionRule } from "@arden-hq/protocol/permissions"
import { isWithin } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import type {
  StructuredCompletion,
  StructuredCompletionRole
} from "../models/structured-completion.js"
import {
  PermissionRulesError,
  type RuleDecision,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import { PROMPT_CATALOG } from "../prompts/catalog.js"

export type CompiledSubject = Exclude<
  NewPermissionRule["subject"],
  { readonly kind: "words" | "host_commands" }
>

interface CompiledRule {
  readonly decision: RuleDecision
  readonly wire: CompiledSubject
  readonly subject: RuleSubject
}

export interface CompiledWords {
  readonly decision: RuleDecision
  readonly rules: ReadonlyArray<CompiledRule>
  readonly dropped: ReadonlyArray<string>
}

const Decision = Schema.Literals(["allow", "ask", "never"])

const OutputSchema = Schema.Struct({
  decision: Decision,
  rules: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["tool", "connector", "command", "path"]),
      decision: Decision,
      tool: Schema.NullOr(Schema.String),
      server: Schema.NullOr(Schema.String),
      command: Schema.NullOr(Schema.String),
      path: Schema.NullOr(Schema.String),
      access: Schema.NullOr(Schema.Literals(["read", "change"]))
    })
  )
})
type Output = typeof OutputSchema.Type

const wireOf = (rule: Output["rules"][number]): CompiledSubject | string => {
  switch (rule.kind) {
    case "tool":
      return rule.tool === null ? "a tool rule named no tool" : { kind: "tool", tool: rule.tool }
    case "connector":
      return rule.server === null
        ? "a connector rule named no connector"
        : { kind: "connector", server: rule.server }
    case "command":
      return rule.command === null
        ? "a command rule named no command"
        : { kind: "command", command: rule.command }
    case "path":
      if (rule.path === null || rule.access === null) return "a folder rule named no folder"
      if (rule.decision === "ask") return `a folder rule allows or never: ${rule.path}`
      return { kind: "path", path: rule.path, access: rule.access }
  }
}

export const checkCompiled = Effect.fn("RuleCompile.check")(function* (
  rules: ReadonlyArray<{
    readonly decision: RuleDecision
    readonly wire: CompiledSubject | string
  }>,
  subjects: (
    subject: NewPermissionRule["subject"]
  ) => Effect.Effect<ReadonlyArray<RuleSubject>, PermissionRulesError>
) {
  const kept: CompiledRule[] = []
  const dropped: string[] = []
  for (const rule of rules) {
    const wire = rule.wire
    if (typeof wire === "string") {
      dropped.push(wire)
      continue
    }
    if (wire.kind === "path" && rule.decision === "ask") {
      dropped.push(`a folder rule allows or never: ${wire.path}`)
      continue
    }
    const checked = yield* subjects(wire).pipe(
      Effect.map((found) => ({ found, error: undefined })),
      Effect.catchIf(
        (cause) => cause.reason === "invalid",
        (cause) => Effect.succeed({ found: [], error: cause.message })
      )
    )
    if (checked.error !== undefined) dropped.push(checked.error)
    for (const subject of checked.found) {
      if (subject.kind === "path" && isWithin(subject.path, homedir())) {
        dropped.push(`a folder rule too wide for words: ${subject.path}`)
        continue
      }
      kept.push({ decision: rule.decision, wire, subject })
    }
  }
  return { kept, dropped }
})

export const compileWords = Effect.fn("RuleCompile.compile")(function* (input: {
  readonly text: string
  readonly role: StructuredCompletionRole
  readonly sessionId: string | null
  readonly structured: StructuredCompletion["Service"]
  readonly tools: ReadonlyArray<{ readonly name: string; readonly title: string }>
  readonly connectors: ReadonlyArray<{ readonly name: string; readonly title: string }>
  readonly subjects: (
    subject: NewPermissionRule["subject"]
  ) => Effect.Effect<ReadonlyArray<RuleSubject>, PermissionRulesError>
  readonly signal?: AbortSignal
}) {
  const system = PROMPT_CATALOG.ruleCompiler.render({
    tools: input.tools.map((tool) => `- ${tool.name}: ${tool.title}`).join("\n") || "(none)",
    connectors:
      input.connectors.map((server) => `- ${server.name}: ${server.title}`).join("\n") || "(none)",
    home: homedir()
  }).text
  const output = yield* input.structured
    .run({
      role: input.role,
      usage: {
        kind: "composer_shortcut",
        owner:
          input.sessionId === null
            ? { type: "none" }
            : { type: "session", sessionId: input.sessionId }
      },
      system,
      user: input.text,
      output: OutputSchema,
      outputName: "compiled_rule",
      maxOutputTokens: 800,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PermissionRulesError({
            operation: "save",
            reason: "storage",
            message: "Couldn't read those words into rules",
            cause
          })
      )
    )
  const { kept, dropped } = yield* checkCompiled(
    output.rules.map((rule) => ({ decision: rule.decision, wire: wireOf(rule) })),
    input.subjects
  )
  return { decision: output.decision, rules: kept, dropped } satisfies CompiledWords
})
