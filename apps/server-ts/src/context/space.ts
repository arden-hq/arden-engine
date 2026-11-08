import { Effect } from "effect"
import type { SpaceStore } from "../persistence/spaces/store.js"
import type { SummaryStore } from "../persistence/summaries/store.js"
import type { WorkStore } from "../persistence/work/store.js"
import type { MemoryTurn } from "../memory/service.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import type { SpaceView } from "./space-render.js"
import { cutText } from "@arden-hq/std/text"
import { renderPromptSection } from "../prompts/format.js"

const SPACE_CONTEXT_AUTHORITY = renderPromptSection(
  "Space context authority",
  PROMPT_TEXT.spaceAuthority
)

const SPACE_THREADS = renderPromptSection(
  "Before you answer: is this a new thread?",
  PROMPT_TEXT.spaceThreads
)

interface SpaceConversationContextSnapshot {
  readonly authority: string
  readonly view: SpaceView
  readonly threads: string
  readonly pageId?: string
}

interface SpaceConversationContextInput {
  readonly spaceId: string | undefined
  readonly sessionId: string
  readonly spaces: SpaceStore["Service"]
  readonly summaries: Pick<SummaryStore["Service"], "spaceChats">
  readonly memory: MemoryTurn | undefined
  readonly work: Pick<WorkStore["Service"], "questions">
}

export const spaceConversationContextSnapshot = Effect.fn("Context.spaceConversationSnapshot")(
  function* ({
    spaceId,
    sessionId,
    spaces,
    summaries,
    memory,
    work
  }: SpaceConversationContextInput) {
    if (spaceId === undefined) return undefined
    const space = yield* spaces.get(spaceId)
    if (space === null) return undefined
    const detail = yield* spaces.detail(spaceId)
    const conversation = detail?.sessions.find(
      (session) => session.session_id === detail.conversation_session_id
    )
    const chats = (detail?.sessions ?? []).filter(
      (session) => session.session_id !== detail?.conversation_session_id
    )
    const summarized = new Map(
      (yield* summaries.spaceChats(spaceId)).map((summary) => [summary.sessionId, summary])
    )
    const questions = yield* work.questions({ space_id: spaceId, state: "actionable" })
    const items = new Map((detail?.work.work_items ?? []).map((task) => [task.item_id, task]))
    const page =
      space.page_id === null || memory === undefined
        ? undefined
        : yield* memory
            .readContent(space.page_id)
            .pipe(Effect.catchTag("WikiError", () => Effect.succeed(undefined)))
    return {
      view: {
        space_id: space.space_id,
        name: space.name,
        instructions: space.instructions ?? undefined,
        isConversation: sessionId === detail?.conversation_session_id,
        conversation:
          conversation === undefined
            ? undefined
            : {
                session_id: conversation.session_id,
                session_ref: conversation.session_ref,
                name: conversation.name ?? "Untitled",
                summary: summarized.get(conversation.session_id)?.summary
              },
        chats: chats.map((session) => ({
          session_id: session.session_id,
          session_ref: session.session_ref,
          name: session.name ?? "Untitled",
          summary: summarized.get(session.session_id)?.summary
        })),
        page: page === undefined ? undefined : { path: page.path, content: page.content },
        questions: questions.questions.map((question) => ({
          question_id: question.question_id,
          prompt: question.content.prompt,
          detail: question.content.detail ?? undefined,
          choices: question.content.choices.map((choice) => choice.label),
          task:
            question.context.task === null
              ? undefined
              : cutText(
                  items.get(question.context.task.item_id)?.text ?? question.context.task.item_id,
                  160
                )
        })),
        tasks: detail?.work.work_items ?? []
      },
      authority: SPACE_CONTEXT_AUTHORITY,
      threads: SPACE_THREADS,
      ...(page === undefined ? {} : { pageId: page.pageId })
    } satisfies SpaceConversationContextSnapshot
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Space conversation context unavailable", cause).pipe(Effect.as(undefined))
  )
)
