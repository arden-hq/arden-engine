import { randomBytes } from "node:crypto"

import { errorMessage } from "@arden-hq/std/errors"

import {
  createTool,
  PauseRequested,
  ToolExecutionError,
  type ModelRequestMiddleware,
  type Tool
} from "@arden-hq/loop"
import { Effect, Predicate, Schema } from "effect"

import { BrowserClient } from "../browser/service.js"
import { StructuredCompletion, StructuredCompletionError } from "../models/structured-completion.js"
import {
  ActParametersSchema,
  SnapshotParametersSchema,
  WaitParametersSchema
} from "./browser-parameters.js"
import { withPageAfter } from "./browser-page.js"
import { refusalOf, typingRule } from "./browser-task-rules.js"
import { BrowserProcedures } from "../browser/procedures/service.js"
import {
  atNodeRef,
  browserOutput,
  runBrowserForRun,
  tabInUse,
  TabRefSchema,
  webUrl
} from "./browser-support.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { BROWSER_TASK_TOOL, NESTED_CALL_MARKERS } from "../persistence/tools/tool-roles.js"
import {
  nestedCallIds,
  PREVIEW_CHARS,
  resultPreview,
  trimmedArgs,
  type ScriptProgressTool
} from "../workflows/runtime/nested-trace.js"
import type { JsonObject } from "../persistence/json.js"
import type { ServerRunContext } from "./run-context.js"

const DEFAULT_STEPS = 25
const MAX_STEPS = 60
const WORKER_PAGE_CHARS = 8_000

const ParametersSchema = Schema.Struct({
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

const ResultSchema = Schema.Struct({
  status: Schema.Literals(["done", "blocked", "decide"] as const).annotate({
    description:
      "done: the goal is met. blocked: it cannot go on (an approval, a missing value, an error page, a check for a person). decide: a choice the caller must make."
  }),
  report: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)).annotate({
    description:
      "What you did and what the page shows now, in a few short lines. For blocked or decide, the exact step or question."
  })
})

const WORKER_SYSTEM = [
  "You carry out one browser goal on one tab for the agent that called you, through browser_snapshot, browser_act and browser_wait, then call finish once.",
  "Start with one browser_snapshot of the tab (mode interactive). After that, never call browser_snapshot to look again: each browser_act result ends with the page after it and its new Snapshot ref, and that is the page you act on next.",
  "On a page with several things to do (a form), use browser_steps: every field, every answer, then the button, in one call built from that page. Use browser_act for a single action.",
  "Type only the values you were given, exactly; never invent a name, an answer or any other value. When a field needs a value you do not have, finish with decide and name the field.",
  "Stay on the goal: do not submit, pay, send, delete or accept anything the goal does not say to. Stop at the point the goal names.",
  "If a call is refused because it needs the user's approval, or the page asks for a person (a captcha, a sign-in, a code), finish with blocked and say which step.",
  "If an action fails twice, finish with blocked. Do not repeat a failed action unchanged.",
  "If browser control belongs to the user (they took control), finish with blocked at once."
].join(" ")

const PAGE_BUDGET_CHARS = 120_000
const DROPPED_PAGE =
  "[An earlier page, dropped to keep this context small. Act on the latest page.]"

const keepRecentPages = (): ModelRequestMiddleware => {
  const dropped = new Set<string>()
  return (request, next) => {
    const kept = request.messages.flatMap((message) =>
      message.role === "tool" && !dropped.has(message.tool_call_id) ? [message] : []
    )
    const size = kept.reduce((total, message) => total + message.content.length, 0)
    const latestPage = kept.findLastIndex((message) => message.content.includes("Snapshot: snap-"))
    if (size > PAGE_BUDGET_CHARS && latestPage > 0)
      for (const message of kept.slice(0, latestPage)) dropped.add(message.tool_call_id)
    return next({
      ...request,
      messages: request.messages.map((message) =>
        message.role === "tool" && dropped.has(message.tool_call_id)
          ? { ...message, content: DROPPED_PAGE }
          : message
      )
    })
  }
}

type WorkerSchema = Schema.ConstraintDecoder<{ readonly tab_ref: string }>

type TaskCtx = {
  readonly run: ServerRunContext
  readonly signal: AbortSignal
  readonly toolCallId: string
  readonly messages: Parameters<ServerRunContext["codeMode"]["call"]>[0]["messages"]
}

const makeTrail = (ctx: TaskCtx, title: string) => {
  const tools = new Map<string, ScriptProgressTool>()
  const data = (): JsonObject => ({
    kind: "code_mode",
    phase_entries: [],
    phases: [title],
    agents: [],
    tools: [...tools.values()].map(
      ({ source_refs: _sources, change_evidence: _changes, ...tool }) => ({ ...tool })
    ),
    logs: []
  })
  const report = (): void => {
    const done = [...tools.values()].filter((tool) => tool.status !== "running").length
    void ctx.run
      .emitToolProgress({
        toolCallId: ctx.toolCallId,
        message: `${title}: ${done} browser calls done`,
        data: { ...data(), tools: [...tools.values()].map((tool) => ({ ...tool })) }
      })
      .catch(() => undefined)
  }
  return {
    data,
    set: (entry: ScriptProgressTool): void => {
      tools.set(entry.tool_call_id, entry)
      report()
    },
    refused: () => [...tools.values()].filter((tool) => tool.status === "failed").length
  }
}

type TaskState = {
  readonly tabRef: string
  readonly origin: string
  readonly rule: ReturnType<typeof typingRule>
  readonly secrets: ReadonlyArray<string>
  readonly mint: (name: string, args: Schema.Json) => string
  readonly trail: ReturnType<typeof makeTrail>
  readonly halt: (cause: PauseRequested) => void
  readonly spend: () => boolean
  readonly signal: AbortSignal
}

const runNested = async (
  ctx: TaskCtx,
  task: TaskState,
  name: string,
  given: { readonly tab_ref: string },
  plan?: StepsPlan
): Promise<string> => {
  const input = carried(ctx, task.tabRef, name, given)
  const refusal = refusalOf({ ...input }, task, (nodeRef) =>
    ctx.run.browserObservations.describe(task.tabRef, nodeRef)
  )
  const args = workerArgs(name, input)
  const toolCallId = task.mint(name, args)
  const onPlan = refusal === undefined && plan?.holds(input) === true
  if (onPlan) plan?.cover(toolCallId)
  const entry: ScriptProgressTool = {
    phase_id: null,
    tool_call_id: toolCallId,
    name,
    phase: null,
    status: "running",
    changes_state: ctx.run.codeMode.changesState(name),
    args: trimmedArgs(args),
    preview: null
  }
  if (refusal !== undefined) {
    task.trail.set({ ...entry, status: "failed", preview: refusal.slice(0, PREVIEW_CHARS) })
    throw new ToolExecutionError(refusal, { preview: "Not in this task", retryable: false })
  }
  if (!task.spend())
    throw new ToolExecutionError(
      "This task has used all its browser calls; finish now with what the page shows.",
      { preview: "No browser calls left", retryable: false }
    )
  task.trail.set(entry)
  let facts = {}
  try {
    const result = await ctx.run.codeMode.call({
      approvalContinuation: "caller",
      toolCallId,
      name,
      args,
      signal: task.signal,
      detached: false,
      messages: ctx.messages,
      onSettled: (settled) => {
        facts = settled
      }
    })
    task.trail.set({ ...entry, ...facts, status: "completed", preview: resultPreview(result) })
    plan?.ran(onPlan)
    const content = Predicate.isObject(result) ? result.content : undefined
    const page = typeof content === "string" ? content : "Done."
    return page
  } catch (cause) {
    task.trail.set({
      ...entry,
      ...facts,
      status: "failed",
      preview: cause instanceof Error ? cause.message.slice(0, PREVIEW_CHARS) : null
    })
    if (cause instanceof PauseRequested) task.halt(cause)
    throw cause
  }
}

const nestedTool = (
  ctx: TaskCtx,
  task: TaskState,
  { name, description, schema }: { name: string; description: string; schema: WorkerSchema }
): Tool<void | undefined> =>
  createTool({
    name,
    description,
    parameters: Schema.toStandardSchemaV1(schema),
    metadata: { kind: "browser", action: "read", source: "_browser", changes_state: false },
    execute: async (given: { readonly tab_ref: string }) => ({
      result: await runNested(ctx, task, name, given),
      preview: name
    })
  })

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

const StepsSchema = Schema.Struct({
  tab_ref: ActParametersSchema.fields.tab_ref,
  profile_ref: ActParametersSchema.fields.profile_ref,
  origin: ActParametersSchema.fields.origin,
  snapshot_ref: ActParametersSchema.fields.snapshot_ref,
  steps: Schema.Array(StepSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
    description: "The actions, in order, all built from that one page: each field, then the button."
  })
})

const stepsTool = (ctx: TaskCtx, task: TaskState): Tool<void | undefined> =>
  createTool({
    name: "browser_steps",
    description:
      "Do several actions on the current page in one call: fill each field, choose each answer, then press the button, all built from the latest page and its Snapshot ref. Stops at the first action that fails, and returns the page after the last one that ran.",
    parameters: Schema.toStandardSchemaV1(StepsSchema),
    metadata: { kind: "browser", action: "read", source: "_browser", changes_state: false },
    execute: async ({ steps, ...page }: typeof StepsSchema.Type) => {
      const plan = stepsPlan(ctx, page, steps)
      let last = ""
      try {
        for (const [index, step] of steps.entries()) {
          try {
            last = await runNested(ctx, task, "browser_act", { ...page, ...step }, plan)
          } catch (cause) {
            if (cause instanceof PauseRequested) throw cause
            const reason = errorMessage(cause)
            return {
              result: `Step ${index + 1} of ${steps.length} failed: ${reason}${last === "" ? "" : `\n\nThe page after step ${index}:\n${last}`}`,
              preview: "Steps stopped"
            }
          }
        }
      } finally {
        plan.close()
      }
      return { result: `All ${steps.length} steps done.\n\n${last}`, preview: "Steps done" }
    }
  })

interface StepsPlan {
  readonly holds: (input: Readonly<Record<string, unknown>>) => boolean
  readonly cover: (toolCallId: string) => void
  readonly ran: (onPlan: boolean) => void
  readonly close: () => void
}

const stepsPlan = (
  ctx: TaskCtx,
  page: Omit<typeof StepsSchema.Type, "steps">,
  steps: (typeof StepsSchema.Type)["steps"]
): StepsPlan => {
  const state = ctx.run.browserObservations
  const basis = state.latest(page.tab_ref)
  const url = basis?.ref === page.snapshot_ref ? basis.url : undefined
  const origin = url === undefined ? undefined : webUrl(url)?.origin
  let expected: string | undefined = origin === page.origin ? page.snapshot_ref : undefined
  const opened = ctx.run.reviewPlans.open({
    name: "browser_steps",
    description:
      "Several browser actions on one page, judged together: each runs only while it stays on this page and origin.",
    args: {
      tab_ref: page.tab_ref,
      origin: page.origin,
      url: url ?? null,
      steps: steps.map((step) => {
        const nodeRef = step.target?.node_ref
        const element =
          nodeRef === undefined ? undefined : state.describe(page.tab_ref, atNodeRef(nodeRef))
        return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))({
          ...step,
          ...(element === undefined ? {} : { element })
        })
      })
    },
    preview: `${steps.length} browser actions on ${page.origin}: ${steps.map((step) => step.action).join(", ")}`
  })
  return {
    holds: (input) => {
      const latest = state.latest(page.tab_ref)
      return (
        expected !== undefined &&
        input["tab_ref"] === page.tab_ref &&
        input["origin"] === page.origin &&
        input["snapshot_ref"] === expected &&
        latest?.url !== undefined &&
        latest.url === url &&
        basis !== undefined &&
        sameTarget(basis.targets, latest.targets, input)
      )
    },
    cover: opened.cover,
    ran: (onPlan) => {
      expected = onPlan ? state.latest(page.tab_ref)?.ref : undefined
    },
    close: opened.close
  }
}

const sameTarget = (
  planned: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
  input: Readonly<Record<string, unknown>>
): boolean => {
  if (!isRefAct(input)) return false
  if (input.target === undefined)
    return JSON.stringify(Object.entries(planned)) === JSON.stringify(Object.entries(now))
  const nodeRef = input.target.node_ref
  if (nodeRef === undefined) return false
  const label = planned[atNodeRef(nodeRef)]
  return label !== undefined && now[atNodeRef(nodeRef)] === label
}

const isRefAct = Schema.is(
  Schema.Struct({
    snapshot_ref: Schema.String,
    target: Schema.optionalKey(Schema.Struct({ node_ref: Schema.optionalKey(Schema.String) }))
  })
)

const carried = <Input extends { readonly tab_ref: string }>(
  ctx: TaskCtx,
  tabRef: string,
  name: string,
  input: Input
): Input => {
  if (name !== "browser_act" || !isRefAct(input)) return input
  const nodeRef = input.target?.node_ref
  const latest = ctx.run.browserObservations.carryOver(
    tabRef,
    input.snapshot_ref,
    nodeRef === undefined ? undefined : atNodeRef(nodeRef)
  )
  return latest === undefined ? input : { ...input, snapshot_ref: latest }
}

const workerArgs = (name: string, input: Readonly<Record<string, unknown>>): JsonObject => {
  const args = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))({ ...input })
  if (name === "browser_snapshot" && args["max_chars"] === undefined)
    return { ...args, max_chars: WORKER_PAGE_CHARS }
  if (name === "browser_act" && args["snapshot"] === undefined)
    return { ...args, snapshot: { max_chars: WORKER_PAGE_CHARS } }
  return args
}

const tabInfo = async (
  browser: BrowserClient["Service"],
  ctx: TaskCtx,
  tabRef: string
): Promise<
  { readonly url: string; readonly origin: string; readonly profile: string } | undefined
> => {
  const tabs = await runBrowserForRun(browser, ctx, { type: "tabs" }, ctx.signal)
  const listed = Schema.decodeUnknownOption(
    Schema.Struct({
      tabs: Schema.Array(
        Schema.Struct({ tab_ref: Schema.String, url: Schema.String, profile_ref: Schema.String })
      )
    })
  )(tabs.data)
  const tab =
    listed._tag === "Some" ? listed.value.tabs.find((each) => each.tab_ref === tabRef) : undefined
  const parsed = tab === undefined ? undefined : webUrl(tab.url)
  return tab === undefined || parsed === undefined
    ? undefined
    : { url: tab.url, origin: parsed.origin, profile: tab.profile_ref }
}

const workerBrief = (input: typeof ParametersSchema.Type): string =>
  [
    `Tab: ${input.tab_ref}`,
    `Goal: ${input.goal}`,
    ...(input.done_when === undefined ? [] : [`Done when: ${input.done_when}`]),
    input.values === undefined || input.values.trim() === ""
      ? "Values: none given; type nothing."
      : `Values (type only these):\n${input.values}`,
    ...(input.secrets === undefined || input.secrets.length === 0
      ? []
      : [
          `Saved secrets you may fill by name (fill with secret, never value): ${input.secrets.join(", ")}`
        ])
  ].join("\n")

const makeBrowserTaskTool = ({
  browser,
  completion,
  procedures
}: {
  readonly browser: BrowserClient["Service"]
  readonly completion: StructuredCompletion["Service"]
  readonly procedures: BrowserProcedures["Service"]
}): ServerTool =>
  defineServerTool({
    name: BROWSER_TASK_TOOL,
    description: [
      "Hand a bounded goal on one browser tab to a fast worker model: fill a form, go through a list, page through results.",
      "It runs the steps itself (each call passes the same approval gate and is recorded) and returns done, blocked or decide with a short report, and the page as it is now with a Snapshot ref for your next browser_act.",
      "Use it for three or more steps toward one goal; give every value it must type in values (it types nothing else). Do a single step, or one that needs judgment at every move, yourself.",
      "Matching saved browser procedures run first. Each step keeps its normal approval and recovery path."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "none",
      code_mode: false,
      display_name: "Browser task",
      kind: "browser",
      action: "read",
      approval_preview: "Let a fast model do these steps in the browser.",
      source: "_browser",
      changes_state: false,
      concurrency_group: "browser",
      destructive: false,
      policy_scope: "external",
      open_world: true,
      idempotent: false
    },
    execute: async (input, ctx) => {
      const modelUsage = ctx.run.modelUsage
      if (modelUsage === undefined)
        throw new ToolExecutionError(
          "A browser task runs only inside a chat run. Do the steps directly with browser_act.",
          { preview: "Worker unavailable", retryable: false }
        )
      const brief = workerBrief(input)
      const trail = makeTrail(ctx, `Browser task: ${input.goal.slice(0, 60)}`)
      const stop = new AbortController()
      let halted: PauseRequested | undefined
      let refusedAdmission: { readonly cause: unknown } | undefined
      const signal = AbortSignal.any([ctx.signal, stop.signal])
      const state = ctx.run.browserObservations
      const release = state.lease(input.tab_ref, ctx.toolCallId)
      if (release === undefined) throw tabInUse()
      const callerView = state.view(input.tab_ref)
      const tab = await tabInfo(browser, ctx, input.tab_ref).catch((cause: unknown) => {
        release()
        throw cause
      })
      if (tab === undefined) {
        release()
        throw new ToolExecutionError(
          "Arden cannot tell which site this tab is on. Open the page first, then hand over the task.",
          { preview: "Site unknown", retryable: false }
        )
      }
      const origin = tab.origin
      const maxSteps = input.max_steps ?? DEFAULT_STEPS
      let ran = 0
      const task = {
        spend: () => {
          if (ran >= maxSteps) return false
          ran += 1
          return true
        },
        tabRef: input.tab_ref,
        origin,
        rule: typingRule(brief, input.values ?? ""),
        secrets: input.secrets ?? [],
        mint: nestedCallIds(
          ctx.toolCallId,
          `${NESTED_CALL_MARKERS[BROWSER_TASK_TOOL]}${randomBytes(4).toString("hex")}-`
        ),
        trail,
        signal,
        halt: (cause: PauseRequested) => {
          halted ??= cause
          stop.abort(cause)
        }
      }
      const bound = (name: string, description: string, schema: WorkerSchema) =>
        nestedTool(ctx, task, { name, description, schema })
      const tools = [
        bound(
          "browser_snapshot",
          "Read the tab once at the start: interactive (refs and a Snapshot ref for browser_act) or text. Not after an act: its result already is the new page.",
          SnapshotParametersSchema
        ),
        bound(
          "browser_act",
          "One action built from the latest page and its Snapshot ref; returns the page after it.",
          ActParametersSchema
        ),
        bound("browser_wait", "Wait for one condition, then read again.", WaitParametersSchema),
        stepsTool(ctx, task)
      ]
      const work = (note: string) =>
        completion
          .runTool({
            role: "helper",
            usage: {
              kind: "run",
              run: {
                ...modelUsage,
                admit: (sampleId) =>
                  modelUsage.admit(sampleId).catch((cause: unknown) => {
                    refusedAdmission ??= { cause }
                    throw cause
                  })
              }
            },
            system: WORKER_SYSTEM,
            user: note === "" ? brief : `${brief}\n${note}`,
            maxOutputTokens: 4_000,
            signal,
            result: {
              schema: ResultSchema,
              name: "finish",
              displayName: "Browser task finished",
              description: "End the task once: done, blocked or decide, with a short report."
            },
            steps: {
              tools,
              maxIterations: maxSteps + 1,
              maxToolCalls: maxSteps + 1,
              modelRequestMiddlewares: [keepRecentPages()]
            }
          })
          .pipe(
            Effect.catchTag("StructuredCompletionError", (error: StructuredCompletionError) =>
              error.reason === "invalid_output" ||
              halted !== undefined ||
              refusedAdmission !== undefined
                ? Effect.succeed({
                    status: "blocked" as const,
                    report: `The worker stopped after ${ran} browser calls without finishing.`
                  })
                : Effect.fail(
                    new ToolExecutionError(
                      `${error.message}. Do the steps directly with browser_act.`,
                      { preview: "Worker unavailable", retryable: false }
                    )
                  )
            )
          )
      const finished = await (async () => {
        const saved = await procedures.tryRun(
          {
            tab: input.tab_ref,
            url: tab.url,
            origin,
            profile: tab.profile,
            goal: input.goal,
            values: input.values ?? "",
            secrets: input.secrets ?? [],
            maxSteps,
            lifecycle: "caller"
          },
          ctx
        )
        if (saved !== undefined) return { saved }
        ran = await Effect.runPromise(procedures.spent(ctx.run.runId, ctx.toolCallId))
        if (ran >= maxSteps)
          return {
            finished: {
              status: "blocked" as const,
              report:
                "The saved steps used this task's browser-call budget. Inspect the current page before continuing."
            }
          }
        return { finished: await Effect.runPromise(work(""), { signal: ctx.signal }) }
      })().finally(() => {
        release()
        state.remember(input.tab_ref, callerView)
      })
      if (halted !== undefined) throw halted
      if (refusedAdmission !== undefined) throw refusedAdmission.cause
      if ("saved" in finished) return finished.saved
      const outcome = finished.finished
      const answer = {
        result: `Browser task ${outcome.status} after ${ran} browser calls.\n${outcome.report}`,
        preview: `Browser task ${outcome.status}`,
        data: { ...trail.data(), status: outcome.status }
      }
      return browserOutput(
        await withPageAfter(browser, ctx, answer, {
          tabRef: input.tab_ref,
          after: undefined,
          navigates: false
        })
      )
    }
  })

export const browserTaskTools = Effect.gen(function* () {
  return [
    makeBrowserTaskTool({
      browser: yield* BrowserClient,
      completion: yield* StructuredCompletion,
      procedures: yield* BrowserProcedures
    })
  ]
})
