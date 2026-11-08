import { Effect } from "effect"
import type { Decisions } from "../models/decisions/service.js"
import type {
  AutomationEventScreen,
  AutomationJobLeaseRef,
  AutomationJobPrefilterEvent,
  StoredAutomationRunSkip
} from "../persistence/automations/store.js"

const SCREEN_CONCURRENCY = 4

export const screenEventWake = (
  decisions: Pick<Decisions["Service"], "decide">
): ((job: AutomationJobLeaseRef) => Effect.Effect<AutomationEventScreen | undefined>) =>
  Effect.fn("Automation.screenEventWake")(function* (job: AutomationJobLeaseRef) {
    const prefilter = job.payload.prefilter
    if (prefilter === null || job.payload.occurrence !== "event" || job.payload.chatRun !== null)
      return undefined
    const verdicts = yield* Effect.forEach(
      prefilter.events,
      (event) =>
        judgeEvent(decisions, event).pipe(
          Effect.map((skip) => ({ key: event.key, skip }) as const)
        ),
      { concurrency: SCREEN_CONCURRENCY }
    )
    const [first, ...rest] = verdicts.flatMap(({ key, skip }) =>
      skip === undefined ? [] : [{ key, skip }]
    )
    if (first === undefined) return undefined
    return {
      skipped: [first, ...rest],
      passed: verdicts.flatMap(({ key, skip }) => (skip === undefined ? [key] : []))
    }
  })

const judgeEvent = Effect.fn("Automation.judgeEvent")(function* (
  decisions: Pick<Decisions["Service"], "decide">,
  event: AutomationJobPrefilterEvent
): Effect.fn.Return<StoredAutomationRunSkip | undefined> {
  if (event.sentences === null) return undefined
  const ask = (sentence: string) =>
    decisions.decide({
      site: "automation_prefilter",
      question: {
        kind: "predicate",
        instructions: `The event matches this condition: ${sentence}`
      },
      state: { event: event.prompt },
      default: true
    })
  const [head, ...tail] = event.sentences
  const first = yield* ask(head)
  if (first.by === "default" || first.value) return undefined
  for (const sentence of tail) {
    const decided = yield* ask(sentence)
    if (decided.by === "default" || decided.value) return undefined
  }
  return {
    reason: "prefilter",
    backend: first.backend,
    event: event.event,
    asked: event.sentences,
    ran: null,
    cancelled: null,
    prompt: event.prompt
  }
})
