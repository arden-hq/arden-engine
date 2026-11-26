import { Schema } from "effect"

import { ActParametersSchema } from "./browser-parameters.js"
import { TabRefSchema } from "./browser-support.js"
import type { ServerRunContext } from "./run-context.js"

export const DEFAULT_STEPS = 25
const MAX_STEPS = 60
export const WORKER_PAGE_CHARS = 8_000

export const ParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "The one tab the worker works in, from browser_tabs or browser_open."
  }),
  goal: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)).annotate({
    description:
      'What to do on this page, in plain words, and where to stop: "Fill the application form and stop before Submit."'
  }),
  values: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(20_000)).annotate({
      description:
        "Every fact the worker may type (names, answers, a cover letter), as label: value lines. It types nothing else."
    })
  ),
  secrets: Schema.optionalKey(
    Schema.Array(Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(100)))
      .check(Schema.isMaxLength(10))
      .annotate({
        description:
          "Names of saved site secrets (from browser_ask_secret) the worker may fill. It fills no other."
      })
  ),
  done_when: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
      description:
        'Text the page shows, word for word, once the goal is met: "Review your application". The worker checks this alongside the goal.'
    })
  ),
  max_steps: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STEPS })).annotate({
      description: `Browser calls the task may make, 1-${MAX_STEPS}, each step of a batch counted. Defaults to ${DEFAULT_STEPS}.`
    })
  )
})

export const ResultSchema = Schema.Struct({
  status: Schema.Literals(["done", "blocked", "decide"] as const).annotate({
    description:
      "done: the goal is met. blocked: it cannot go on (an approval, a missing value, an error page, a check for a person). decide: a choice the caller must make."
  }),
  report: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)).annotate({
    description:
      "What you did and what the page shows now, in a few short lines. For blocked or decide, the exact step or question."
  })
})

export const WORKER_SYSTEM = [
  "You carry out one browser goal on one tab for the agent that called you, through browser_snapshot, browser_act and browser_wait, then call finish once.",
  "Start with one browser_snapshot of the tab (mode interactive). After that, never call browser_snapshot to look again: each browser_act result ends with the page after it and its new Snapshot ref, and that is the page you act on next.",
  "On a page with several things to do (a form), use browser_steps: every field, every answer, then the button, in one call built from that page. Use browser_act for a single action.",
  "Type only the values you were given, exactly; never invent a name, an answer or any other value. When a field needs a value you do not have, finish with decide and name the field.",
  "Stay on the goal: do not submit, pay, send, delete or accept anything the goal does not say to. Stop at the point the goal names.",
  "If a call is refused because it needs the user's approval, or the page asks for a person (a captcha, a sign-in, a code), finish with blocked and say which step.",
  "If an action fails twice, finish with blocked. Do not repeat a failed action unchanged.",
  "If browser control belongs to the user (they took control), finish with blocked at once."
].join(" ")

export type WorkerSchema = Schema.ConstraintDecoder<{ readonly tab_ref: string }>

export type TaskCtx = {
  readonly run: ServerRunContext
  readonly signal: AbortSignal
  readonly toolCallId: string
  readonly messages: Parameters<ServerRunContext["codeMode"]["call"]>[0]["messages"]
}

const StepSchema = ActParametersSchema.mapFields(
  ({
    tab_ref: _tab,
    profile_ref: _profile,
    origin: _origin,
    snapshot_ref: _ref,
    snapshot: _after,
    ...step
  }) => step
)

export const StepsSchema = Schema.Struct({
  tab_ref: ActParametersSchema.fields.tab_ref,
  profile_ref: ActParametersSchema.fields.profile_ref,
  origin: ActParametersSchema.fields.origin,
  snapshot_ref: ActParametersSchema.fields.snapshot_ref,
  steps: Schema.Array(StepSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
    description: "The actions, in order, all built from that one page: each field, then the button."
  })
})
