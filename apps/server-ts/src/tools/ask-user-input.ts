import { Schema } from "effect"
import { RunQuestionContentSchema } from "@arden-hq/protocol/effect/runs"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"
import type { OfferRequest } from "./permission-offer.js"
import { wordsRuleText } from "../persistence/permissions/rules.js"

const WORDS_OFFER_MAX = 120
import { slugify } from "@arden-hq/std/slug"

type QuestionContent = typeof RunQuestionContentSchema.Type
const choiceFields = RunQuestionContentSchema.fields.choices.value.fields

const FocusTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing").annotate({
      description: "Open an existing ordinary Chat."
    }),
    session_ref: Schema.NonEmptyString.check(Schema.isMaxLength(1024)).annotate({
      description: "Exact reference of another active ordinary Chat in the current Space."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("create").annotate({
      description: "Create one new ordinary Chat."
    }),
    name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)).pipe(
      Schema.annotateEncoded({
        description: "Name for one new ordinary Chat in the current Space."
      })
    ),
    purpose: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(
      Schema.annotateEncoded({
        description: "One sentence: what the thread is for."
      })
    ),
    starts_with: Schema.Array(
      Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300))
    ).pipe(
      Schema.check(Schema.isMaxLength(6)),
      Schema.annotateEncoded({
        description:
          "What is already decided, then the next step, one short line each. The new Chat starts from these."
      })
    )
  })
]).annotate({
  description:
    "Offer to keep working here or open this target. Use it whenever the user asks for, suggests or asks your opinion on a separate chat, rather than only agreeing in prose; it is valid from the active Space conversation or an ordinary Chat in that Space. It brings its own answers, so leave choices out. It carries no permission grant."
})

const ChoiceInputSchema = Schema.Union([
  choiceFields.label,
  Schema.Struct({ label: choiceFields.label, detail: choiceFields.detail })
])

export const AskUserParametersSchema = Schema.Struct({
  prompt: RunQuestionContentSchema.fields.prompt.annotate({
    description: "One specific question that needs the user's decision."
  }),
  detail: RunQuestionContentSchema.fields.detail.annotate({
    description:
      "At most one short sentence of context the answer depends on, or the material itself behind an exact Markdown link on its own paragraph: [Open draft](returned-file-url), [Open form](verified-url), [Review changes](verified-url). The card shows two lines of it; do not restate the question or say what you have not done yet. Standalone links appear as contextual action buttons; label the actual action and reuse a verified destination, never guess one. Opening a link does not answer the question. Use null for a self-contained question."
  }),
  choices: Schema.optionalKey(
    Schema.Array(ChoiceInputSchema)
      .annotate({
        description:
          'Put your most probable, preferred answer first: the option you would choose by default. Up to six answer labels, e.g. ["Cancel it", "Keep it open"]. The user picks one, or several when multiple is true, and can always type their own answer instead or beside them; the card has its own close button (Skip, or Keep on hold on a Task question), so never offer one. Leave out for a free-text answer or when focus_target is set.'
      })
      .check(Schema.isMaxLength(6))
  ),
  multiple: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true only when the user may pick more than one choice, e.g. which of these to keep. Leave out for one choice."
    })
  ),
  timeout: Schema.optionalKey(
    Schema.Struct({
      fallback: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)).annotate({
        description:
          "Exact label of the first choice: your explicit fallback if the user is away. Only use an action already authorized; never use silence as permission."
      }),
      seconds: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2147483)).annotate({
          description: "Seconds to wait. Defaults to 120 (2 minutes); choose longer when useful."
        })
      )
    }).annotate({
      description:
        "Optional timer. Omit for a blocking decision, approval, or permission. Expiry continues with the first choice under existing authority."
    })
  ),
  focus_target: Schema.optionalKey(FocusTargetSchema),
  permission: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        tool: Schema.NonEmptyString.check(Schema.isMaxLength(256)).annotate({
          description: "Exact name of the tool the person spoke about."
        }),
        decision: Schema.optionalKey(
          Schema.Literals(["allow", "ask", "deny"]).annotate({
            description:
              "allow (default): use it without asking. ask: always ask before it. deny: turn it off."
          })
        )
      }),
      Schema.Struct({
        connector: Schema.NonEmptyString.check(Schema.isMaxLength(256)).annotate({
          description:
            'The MCP server whose tools may all run without asking, as their source names it ("you can call GitHub when you want"). Prefer it over one tool when the person names the service.'
        })
      }),
      Schema.Struct({
        mode: ApprovalModeSchema.annotate({
          description:
            'The chat\'s approval mode: allow is Never ask ("all granted", "stop asking me"), safe is Auto, ask is Ask every time, read_only is Read only.'
        })
      }),
      Schema.Struct({
        command: Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
          description:
            'A host command whose prefix may run without asking, as the person would type it ("git push", "runpodctl get pod"). Its card also offers Arden\'s own jobs, the list a built-in automation runs commands under.'
        })
      }),
      Schema.Struct({
        path: Schema.NonEmptyString.check(Schema.isMaxLength(1000)).annotate({
          description:
            'A folder or file by its full path or from ~ ("~/Documents", "~/src/demo"). read: use its files (open, attach, upload); change: write them. allow: without asking; never: not at all ("never touch Documents" is read, never).'
        }),
        access: Schema.Literals(["read", "change"]),
        decision: Schema.Literals(["allow", "never"])
      }),
      Schema.Struct({
        rule: Schema.NonEmptyString.annotate({
          description: "The id of a rule from permissions_read, to change or remove."
        }),
        decision: Schema.Literals(["allow", "ask", "never", "remove"])
      }),
      Schema.Struct({
        words: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(WORDS_OFFER_MAX)
        ).annotate({
          description:
            'The action the rule is about, as a short phrase: "uploading my CV to job sites", "sending an email". The decision goes in `decision`, never in the words: no "always", "never", "you can", "without asking". Nothing the person did not say: no caveats, no "this does not cover…". For what no tool, connector or command names; the Auto reviewer reads it, in Auto only.'
        }),
        decision: Schema.Literals(["allow", "ask", "never"])
      })
    ]).annotate({
      description:
        'Offer a lasting permission change when the person says what you may or may not do ("you can call GitHub when you want", "you can always upload my CV", "stop asking me about clicks", "all granted"): a connector, one tool\'s rule, a folder, the chat\'s approval mode, a command prefix, a change to or removal of a rule by its id, or a rule in their words. When their words name what and whether, offer it at once; ask only what they left out. Offer in any approval mode: a rule holds for every chat of its Space or everywhere. The card names it and offers where it holds; only their tap saves it, so never say it is saved before they answer. If the offer is refused, say so; never ask a plain question in its place, since a plain answer saves nothing. It brings its own question and answers: leave choices and focus_target out.'
    })
  )
}).check(
  Schema.makeFilter((input) => {
    const choices = (input.choices ?? []).length
    if (input.timeout !== undefined) {
      if (
        input.permission !== undefined ||
        input.focus_target !== undefined ||
        input.multiple === true
      )
        return "Timers require an ordinary single-choice question, never a permission or focus decision"
      const first = input.choices?.[0]
      const label = typeof first === "string" ? first : first?.label
      if (label !== input.timeout.fallback)
        return "timeout.fallback must name the first choice exactly"
    }
    if (input.permission !== undefined && (choices > 0 || input.focus_target !== undefined))
      return "Send permission alone: it brings its own question and answers. Leave choices and focus_target out"
    if (input.focus_target !== undefined && choices > 0)
      return "Send focus_target without choices: it brings its own answers (Continue here, Continue in <chat>). To offer your own answers instead, send choices without focus_target"
    if (input.multiple === true && choices < 2)
      return "multiple needs at least two choices to pick from. Leave it out for one choice or a free-text answer"
    return undefined
  })
)

type AskUserInput = typeof AskUserParametersSchema.Type

export const askUserQuestion = (
  input: AskUserInput
): {
  readonly content: QuestionContent
  readonly focusTarget: AskUserInput["focus_target"]
} => {
  const base = { prompt: input.prompt, detail: input.detail }
  if (input.focus_target !== undefined) {
    return {
      content: {
        ...base,
        choices: [
          { id: "continue_here", label: "Continue here" },
          { id: "open_target", label: "Open target" }
        ]
      },
      focusTarget: input.focus_target
    }
  }
  const taken = new Set<string>()
  const choices = (input.choices ?? []).map((written, index) => {
    const choice = typeof written === "string" ? { label: written } : written
    const slugged = slug(choice.label) || `choice_${index + 1}`
    const id = taken.has(slugged) ? `${slugged}_${index + 1}` : slugged
    taken.add(id)
    return { ...choice, id }
  })
  return {
    content: { ...base, choices, ...(input.multiple === true ? { multiple: true } : {}) },
    focusTarget: undefined
  }
}

const slug = (label: string): string =>
  slugify(label, { separator: "_", normalize: "nfkd", lowerFirst: true, max: 48 })

export const permissionRequest = (
  permission: NonNullable<AskUserInput["permission"]>
): OfferRequest => {
  if ("connector" in permission) return { kind: "connector", server: permission.connector }
  if ("mode" in permission) return { kind: "mode", mode: permission.mode }
  if ("command" in permission) return { kind: "command", command: permission.command }
  if ("path" in permission)
    return {
      kind: "path",
      path: permission.path,
      access: permission.access,
      decision: permission.decision
    }
  if ("rule" in permission)
    return { kind: "rule", ruleId: permission.rule, decision: permission.decision }
  if ("words" in permission)
    return { kind: "words", text: wordsRuleText(permission.words), decision: permission.decision }
  return {
    kind: "tool",
    tool: permission.tool,
    decision: TOOL_DECISION[permission.decision ?? "allow"]
  }
}

const TOOL_DECISION = { allow: "approve", ask: "ask", deny: "deny" } as const
