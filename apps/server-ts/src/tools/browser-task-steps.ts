import { Schema } from "effect"
import { BROWSER_TOOL } from "../browser/service.js"

import { atNodeRef, webUrl } from "./browser-support.js"
import { type StepsSchema, type TaskCtx } from "./browser-task-types.js"

export interface StepsPlan {
  readonly holds: (input: Readonly<Record<string, unknown>>) => boolean
  readonly cover: (toolCallId: string) => void
  readonly ran: (onPlan: boolean) => void
  readonly close: () => void
}

export const stepsPlan = (
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

export const carried = <Input extends { readonly tab_ref: string }>(
  ctx: TaskCtx,
  tabRef: string,
  name: string,
  input: Input
): Input => {
  if (name !== BROWSER_TOOL.act || !isRefAct(input)) return input
  const nodeRef = input.target?.node_ref
  const latest = ctx.run.browserObservations.carryOver(
    tabRef,
    input.snapshot_ref,
    nodeRef === undefined ? undefined : atNodeRef(nodeRef)
  )
  return latest === undefined ? input : { ...input, snapshot_ref: latest }
}
