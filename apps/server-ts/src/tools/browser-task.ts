import { ROLE } from "@arden-hq/std/message-vocabulary"
import { randomBytes } from "node:crypto"

import { errorMessage } from "@arden-hq/std/errors"

import {
  createTool,
  PauseRequested,
  ToolExecutionError,
  type ModelRequestMiddleware,
  type Tool
} from "@arden-hq/loop"
import { Effect, Option, Predicate, Schema } from "effect"

import { BROWSER_TOOL, BrowserClient } from "../browser/service.js"
import {
  STRUCTURED_COMPLETION_FAILURE,
  StructuredCompletion,
  StructuredCompletionError
} from "../models/structured-completion.js"
import { APPROVAL_CONTINUATION } from "../workflows/runtime/contract.js"
import {
  ActParametersSchema,
  SnapshotParametersSchema,
  WaitParametersSchema
} from "./browser-parameters.js"
import { withPageAfter } from "./browser-page.js"
import { refusalOf, typingRule } from "./browser-task-rules.js"
import { BrowserProcedures } from "../browser/procedures/service.js"
import { browserOutput, runBrowserForRun, tabInUse, webUrl } from "./browser-support.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { BROWSER_TASK_TOOL, NESTED_CALL_MARKERS, NESTING } from "../persistence/tools/tool-roles.js"
import {
  nestedCallIds,
  PREVIEW_CHARS,
  resultPreview,
  SCRIPT_PROGRESS_STATUS,
  trimmedArgs,
  type ScriptProgressTool
} from "../workflows/runtime/nested-trace.js"
import type { JsonObject } from "../persistence/json.js"
import {
  DEFAULT_STEPS,
  ParametersSchema,
  ResultSchema,
  StepsSchema,
  WORKER_PAGE_CHARS,
  WORKER_SYSTEM,
  type WorkerSchema,
  type TaskCtx
} from "./browser-task-types.js"
import { type StepsPlan, carried, stepsPlan } from "./browser-task-steps.js"

const PAGE_BUDGET_CHARS = 120_000
const DROPPED_PAGE =
  "[An earlier page, dropped to keep this context small. Act on the latest page.]"

const keepRecentPages = (): ModelRequestMiddleware => {
  const dropped = new Set<string>()
  return (request, next) => {
    const kept = request.messages.flatMap((message) =>
      message.role === ROLE.tool && !dropped.has(message.tool_call_id) ? [message] : []
    )
    const size = kept.reduce((total, message) => total + message.content.length, 0)
    const latestPage = kept.findLastIndex((message) => message.content.includes("Snapshot: snap-"))
    if (size > PAGE_BUDGET_CHARS && latestPage > 0)
      for (const message of kept.slice(0, latestPage)) dropped.add(message.tool_call_id)
    return next({
      ...request,
      messages: request.messages.map((message) =>
        message.role === ROLE.tool && dropped.has(message.tool_call_id)
          ? { ...message, content: DROPPED_PAGE }
          : message
      )
    })
  }
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
    const done = [...tools.values()].filter(
      (tool) => tool.status !== SCRIPT_PROGRESS_STATUS.running
    ).length
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
    refused: () =>
      [...tools.values()].filter((tool) => tool.status === SCRIPT_PROGRESS_STATUS.failed).length
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
      approvalContinuation: APPROVAL_CONTINUATION.caller,
      parent: { toolCallId: ctx.toolCallId, nesting: { kind: NESTING.task } },
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

const workerArgs = (name: string, input: Readonly<Record<string, unknown>>): JsonObject => {
  const args = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))({ ...input })
  if (name === BROWSER_TOOL.snapshot && args["max_chars"] === undefined)
    return { ...args, max_chars: WORKER_PAGE_CHARS }
  if (name === BROWSER_TOOL.act && args["snapshot"] === undefined)
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
  const tab = Option.isSome(listed)
    ? listed.value.tabs.find((each) => each.tab_ref === tabRef)
    : undefined
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
    summary: "Hands several steps on a browser page to a faster model.",
    discovery: { group: "web_browser_tasks" },
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
              error.reason === STRUCTURED_COMPLETION_FAILURE.invalid_output ||
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
