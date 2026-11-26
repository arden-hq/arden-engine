import { previewLine } from "@arden-hq/protocol/chat"
import {
  AGENT_CHECKED,
  AGENT_ERROR,
  AGENT_LATEST_RUN,
  AGENT_REPORT,
  AGENT_RUNNING,
  CHAT_SUMMARY,
  SESSION_NAME,
  SPACE_AGENT,
  SPACE_CONVERSATION,
  LAST_LINE,
  LETTER_SUBJECT,
  SPACE_INSTRUCTIONS,
  SPACE_PAGE,
  SPACE_STATE,
  type LastLine,
  type LetterSubject,
  type Space,
  type SpaceAgent,
  type SpaceDetail,
  type SpaceSession,
  type SpaceInstructions,
  type SpacePage
} from "@arden-hq/protocol/spaces"
import { publicMark } from "./mark.js"
import {
  INSTRUCTIONS_SOURCE,
  type SpaceAgentRecord,
  type SpaceDetailRecord,
  type SpaceRecord,
  type SpaceSessionRecord
} from "./store.js"

const publicInstructions = (space: SpaceRecord): SpaceInstructions => {
  if (space.instructions === null) {
    return space.instructions_source === INSTRUCTIONS_SOURCE.manual
      ? { kind: SPACE_INSTRUCTIONS.cleared }
      : { kind: SPACE_INSTRUCTIONS.unwritten }
  }
  return space.instructions_source === INSTRUCTIONS_SOURCE.manual
    ? { kind: SPACE_INSTRUCTIONS.manual, text: space.instructions }
    : { kind: SPACE_INSTRUCTIONS.generated, text: space.instructions }
}

export const publicPage = (pagePath: string | null): SpacePage =>
  pagePath === null ? { kind: SPACE_PAGE.unbound } : { kind: SPACE_PAGE.bound, path: pagePath }

export const publicSpace = (space: SpaceRecord): Space => ({
  inference: space.inference,
  space_id: space.space_id,
  kind: space.kind,
  name: space.name,
  instructions: publicInstructions(space),
  page: publicPage(space.page_path),
  mark: publicMark(space.mark),
  created_at: space.created_at,
  updated_at: space.updated_at,
  state:
    space.archived_at === null
      ? { kind: SPACE_STATE.active }
      : { kind: SPACE_STATE.archived, archived_at: space.archived_at }
})

export const letterSubject = (subject: string | null): LetterSubject =>
  subject === null ? { kind: LETTER_SUBJECT.none } : { kind: LETTER_SUBJECT.given, subject }

const publicLine = (line: string | null): LastLine =>
  line === null ? { kind: LAST_LINE.none } : { kind: LAST_LINE.line, text: line }

export const lastLine = (text: string | null): LastLine => publicLine(previewLine(text))

const publicSession = (session: SpaceSessionRecord): SpaceSession => ({
  session_id: session.session_id,
  session_ref: session.session_ref,
  name:
    session.name === null
      ? { kind: SESSION_NAME.untitled }
      : { kind: SESSION_NAME.named, name: session.name },
  last_line: publicLine(session.last_line),
  summary:
    session.summary === null
      ? { kind: CHAT_SUMMARY.unsummarized }
      : { kind: CHAT_SUMMARY.summarized, text: session.summary },
  last_activity: session.last_activity
})

const publicAgent = (agent: SpaceAgentRecord | null): SpaceAgent =>
  agent === null
    ? { kind: SPACE_AGENT.off }
    : {
        kind: SPACE_AGENT.on,
        status: {
          latest_run:
            agent.latest_run_id === null
              ? { kind: AGENT_LATEST_RUN.none }
              : { kind: AGENT_LATEST_RUN.run, run_id: agent.latest_run_id },
          last_checked:
            agent.last_checked === null
              ? { kind: AGENT_CHECKED.never }
              : { kind: AGENT_CHECKED.at, at: agent.last_checked },
          last_report:
            agent.last_report === null
              ? { kind: AGENT_REPORT.none }
              : { kind: AGENT_REPORT.report, text: agent.last_report },
          woken_by: agent.woken_by,
          runs_today: agent.runs_today,
          runs_cap: agent.runs_cap,
          running:
            agent.running_since === null
              ? { kind: AGENT_RUNNING.idle }
              : { kind: AGENT_RUNNING.running, since: agent.running_since },
          availability: agent.availability,
          last_error:
            agent.last_error === null
              ? { kind: AGENT_ERROR.none }
              : { kind: AGENT_ERROR.failed, error: agent.last_error }
        }
      }

export const publicDetail = (detail: SpaceDetailRecord): SpaceDetail => ({
  conversation:
    detail.conversation_session_id === null
      ? { kind: SPACE_CONVERSATION.unopened }
      : { kind: SPACE_CONVERSATION.opened, session_id: detail.conversation_session_id },
  inference: detail.space.inference,
  key: detail.space.space_id,
  title: detail.space.name,
  page: publicPage(detail.space.page_path),
  instructions: publicInstructions(detail.space),
  agent: publicAgent(detail.agent),
  sessions: detail.sessions.map(publicSession),
  work: detail.work
})
