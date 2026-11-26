import { AUTOMATION_OCCURRENCE, AUTOMATION_RUN_SKIP_REASON } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import { DECIDED_BY, type Decisions } from "../models/decisions/service.js"
import type {
  AutomationEventScreen,
  AutomationJobLeaseRef,
  AutomationJobPrefilterEvent,
  StoredAutomationRunSkip
} from "../persistence/automations/store.js"

const SCREEN_CONCURRENCY = 4

export const screenEventWake = (
  decisions: Pick<Decisions["Service"], "decide">,
  ownerOf: (job: AutomationJobLeaseRef) => Effect.Effect<string | undefined> = () =>
    Effect.succeed(undefined)
): ((job: AutomationJobLeaseRef) => Effect.Effect<AutomationEventScreen | undefined>) =>
  Effect.fn("Automation.screenEventWake")(function* (job: AutomationJobLeaseRef) {
    const prefilter = job.payload.prefilter
    if (
      prefilter === null ||
      job.payload.occurrence !== AUTOMATION_OCCURRENCE.event ||
      job.payload.chatRun !== null
    )
      return undefined
    const owner = yield* ownerOf(job)
    const verdicts = yield* Effect.forEach(
      prefilter.events,
      (event) =>
        judgeEvent(decisions, event, owner).pipe(
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
  event: AutomationJobPrefilterEvent,
  owner: string | undefined
): Effect.fn.Return<StoredAutomationRunSkip | undefined> {
  if (event.sentences === null) return undefined
  const ask = (sentence: string) =>
    decisions.decide({
      site: "automation_prefilter",
      question: {
        kind: "predicate",
        instructions: `The event matches this condition: ${sentence}`
      },
      state: owner === undefined ? { event: event.prompt } : { event: event.prompt, owner },
      default: true
    })
  const [head, ...tail] = event.sentences
  const first = yield* ask(head)
  if (first.by === DECIDED_BY.default || first.value) return undefined
  for (const sentence of tail) {
    const decided = yield* ask(sentence)
    if (decided.by === DECIDED_BY.default || decided.value) return undefined
  }
  return {
    reason: AUTOMATION_RUN_SKIP_REASON.prefilter,
    backend: first.backend,
    event: event.event,
    asked: event.sentences,
    run_with_event: { kind: "not_asked" },
    prompt: event.prompt
  }
})
