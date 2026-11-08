import { answerSaid, answerWords, type RunQuestion } from "@arden-hq/protocol/runs"
import { clipLine } from "@arden-hq/std/text"
import { DateTime, Effect } from "effect"
import type { WorkStore } from "../persistence/work/store.js"
import { renderPromptSection } from "../prompts/format.js"

const ASKED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000
const ASKS_SHOWN = 12

const ASKED_RULE =
  "What Arden already asked the person on this Space in the last 7 days, from any chat, Task or Space review, newest first. Before you ask, read it: if your question asks the same thing, use its answer, or leave the open one to be answered. Never ask it again in other words; ask only what the answer leaves open."

export const spaceAsksContext = Effect.fn("Context.spaceAsks")(
  function* (input: {
    readonly spaceId: string | undefined
    readonly work: Pick<WorkStore["Service"], "questions">
    readonly includeOpen: boolean
  }) {
    if (input.spaceId === undefined) return undefined
    const since = DateTime.toEpochMillis(yield* DateTime.now) - ASKED_WITHIN_MS
    const { questions } = yield* input.work.questions({ space_id: input.spaceId, state: "all" })
    const lines = questions
      .filter((question) => question.permission_offer === null && question.focus_choice === null)
      .flatMap((question) => askedLine(question, since, input.includeOpen))
      .slice(0, ASKS_SHOWN)
    return lines.length === 0
      ? undefined
      : renderPromptSection("Asked on this Space", [ASKED_RULE, ...lines].join("\n"))
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Space asks context unavailable", cause).pipe(Effect.as(undefined))
  )
)

const askedLine = (
  question: RunQuestion,
  since: number,
  includeOpen: boolean
): ReadonlyArray<string> => {
  const prompt = `"${clipLine(question.content.prompt, 200)}"`
  if (question.status === "open")
    return includeOpen && Date.parse(question.created_at) >= since
      ? [`- ${prompt}: open since ${question.created_at.slice(0, 10)}.`]
      : []
  const resolution = question.resolution
  if (resolution === null || Date.parse(resolution.resolved_at) < since) return []
  const said = answerSaid(question.content.choices, resolution.answer)
  if (said === undefined) return []
  return [
    `- ${prompt}: answered ${resolution.resolved_at.slice(0, 10)}: ${clipLine(answerWords(said), 300)}`
  ]
}
