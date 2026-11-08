import type { TaskStateView } from "../persistence/work/task-state.js"
import { PROMPT_CATALOG } from "./catalog.js"
import { renderPromptSection } from "./format.js"

const recordLine = (value: string): string => `- ${value.trim().replaceAll(/\n\s*/g, "\n  ")}`

const section = (name: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => [
  `${name}:`,
  ...(lines.length === 0 ? ["- none"] : lines.map(recordLine))
]

const recordText = (state: TaskStateView | undefined): string => {
  if (state === undefined) return "No record yet: this wake writes the first one."
  const { record, sessionRef, laterWakes } = state
  const where = sessionRef === undefined ? "" : ` in [chat](arden:session/${sessionRef})`
  return [
    `Written ${record.written_at}${where}.`,
    ...section("Done", record.done),
    ...section(
      "In progress",
      record.in_progress.map((job) =>
        job.handle === undefined ? job.what : `${job.what} (handle: ${job.handle})`
      )
    ),
    ...section("Decided", record.decided),
    ...section(
      "Rejected",
      record.rejected.map((option) => `${option.option} (why: ${option.why})`)
    ),
    ...section("Next", record.next),
    ...(laterWakes === 0
      ? []
      : [
          `${laterWakes === 1 ? "The wake" : `The ${laterWakes} wakes`} since ended without rewriting it, so it may be behind.`
        ]),
    sessionRef === undefined
      ? "Find detail it leaves out with session_search_transcripts in this Task's chats, then session_read around the hit."
      : `Find detail it leaves out with session_search_transcripts (session_ref ${JSON.stringify(sessionRef)}), then session_read around the hit.`
  ].join("\n")
}

export const renderTaskStateSection = (state: TaskStateView | undefined): string =>
  renderPromptSection(
    "Task state record",
    PROMPT_CATALOG.taskState.render({ record: recordText(state) }).text
  )
