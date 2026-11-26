import { TOKEN_CAP } from "@arden-hq/protocol/settings"
import {
  SOURCE_KIND,
  SOURCE_REVISION,
  SOURCE_TURN,
  type SourceRevision,
  type SpaceTaskSource,
  CONTRACT_LINE,
  CRITERION_MET,
  EVIDENCE_KIND,
  RESULT_SOURCE,
  TASK_ACTIVITY,
  DECISION_REJECTED,
  EVENT_ITEM,
  EVENT_RUN,
  HOME_CHAT,
  JOB_HANDLE,
  PAGE_NEXT,
  RESULT_SUMMARY,
  RUN_REF,
  RUN_RESULT,
  TASK_BLOCK,
  TASK_BODY,
  TASK_CREATOR,
  TASK_DUE,
  TASK_HISTORY,
  TASK_HOLD,
  TASK_NEXT_ATTEMPT,
  TASK_RUN,
  TASK_SEQ,
  TASK_SPACE,
  TASK_STATE,
  TASK_STATUS,
  TASK_STOP,
  TOOL_EXIT,
  type RunRef,
  type SpaceSnapshot,
  type SpaceTask,
  type SpaceTaskAttachment,
  type SpaceTaskComment,
  type SpaceTaskContractLine,
  type SpaceTaskEvent,
  type SpaceTaskEvidence,
  type SpaceTaskFields,
  type SpaceTaskResult,
  type SpaceTaskRun,
  type SpaceWorkPage,
  type StopSpaceTaskResponse,
  type TaskSpace,
  taskActivityWords
} from "@arden-hq/protocol/spaces/work"
import type {
  SnapshotRecord,
  StopTaskRecord,
  TaskAttachmentRecord,
  TaskCommentRecord,
  TaskContractLineRecord,
  TaskEventRecord,
  TaskEvidenceRecord,
  TaskRecord,
  TaskResultRecord,
  TaskRunRecord,
  TaskSourceRecord,
  WorkPageRecord
} from "./task-record.js"

const taskSpace = (spaceId: string | null): TaskSpace =>
  spaceId === null ? { kind: TASK_SPACE.loose } : { kind: TASK_SPACE.space, space_id: spaceId }

const sourceRevision = (revision: string | null): SourceRevision =>
  revision === null
    ? { kind: SOURCE_REVISION.unrecorded }
    : { kind: SOURCE_REVISION.recorded, revision }

export const publicSource = (source: TaskSourceRecord): SpaceTaskSource => {
  switch (source.kind) {
    case SOURCE_KIND.chat:
      return {
        kind: source.kind,
        session_id: source.session_id,
        turn:
          source.turn_id === null
            ? { kind: SOURCE_TURN.whole_chat }
            : { kind: SOURCE_TURN.turn, turn_id: source.turn_id },
        revision: sourceRevision(source.revision)
      }
    case SOURCE_KIND.task:
      return { ...source, revision: sourceRevision(source.revision) }
    case SOURCE_KIND.space:
      return { ...source, revision: sourceRevision(source.revision) }
    case SOURCE_KIND.memory:
    case SOURCE_KIND.connection_item:
      return source
  }
}

const runRef = (runId: string | null): RunRef =>
  runId === null ? { kind: RUN_REF.none } : { kind: RUN_REF.run, run_id: runId }

const activityFacts = (
  task: Pick<TaskRecord, "activity" | "stop_kind" | "stop_reason" | "blocked" | "waiting_on">
): Pick<SpaceTask, "activity" | "block"> => ({
  activity:
    task.activity === TASK_ACTIVITY.stopped
      ? {
          kind: task.activity,
          stop:
            task.stop_kind === null || task.stop_reason === null
              ? { kind: TASK_STOP.unrecorded }
              : { kind: TASK_STOP.recorded, stop_kind: task.stop_kind, reason: task.stop_reason }
        }
      : { kind: task.activity },
  block:
    task.blocked && task.waiting_on !== null
      ? { kind: TASK_BLOCK.blocked, waiting_on: task.waiting_on }
      : { kind: TASK_BLOCK.unblocked }
})

export const activityWords = (
  task: Parameters<typeof activityFacts>[0],
  clipReason?: (reason: string) => string
): string | undefined => taskActivityWords(activityFacts(task), clipReason)

const publicEvidence = (evidence: TaskEvidenceRecord): SpaceTaskEvidence => {
  if (evidence.kind !== EVIDENCE_KIND.tool_call) return evidence
  const { exit_code: code, ...rest } = evidence
  return {
    ...rest,
    exit: code === undefined ? { kind: TOOL_EXIT.unknown } : { kind: TOOL_EXIT.exited, code }
  }
}

const publicLine = (line: TaskContractLineRecord): SpaceTaskContractLine => {
  switch (line.kind) {
    case CONTRACT_LINE.rule:
      return line
    case CONTRACT_LINE.criterion:
      return {
        ...line,
        met:
          line.met === null
            ? { kind: CRITERION_MET.unmet }
            : {
                kind: CRITERION_MET.met,
                evidence: publicEvidence(line.met.evidence),
                recorded_at: line.met.recorded_at
              }
      }
    case CONTRACT_LINE.decision:
      return {
        ...line,
        rejected:
          line.rejected === null
            ? { kind: DECISION_REJECTED.none }
            : { kind: DECISION_REJECTED.rejected, option: line.rejected }
      }
  }
}

const taskFields = (task: TaskRecord): SpaceTaskFields => ({
  history:
    task.history_revision === null
      ? { kind: TASK_HISTORY.unrecorded }
      : { kind: TASK_HISTORY.recorded, revision: task.history_revision },
  item_id: task.item_id,
  space: taskSpace(task.space_id),
  home_chat:
    task.home_session_id === null
      ? { kind: HOME_CHAT.none }
      : { kind: HOME_CHAT.chat, session_id: task.home_session_id },
  stable_key: task.stable_key,
  text: task.text,
  body:
    task.body === null ? { kind: TASK_BODY.plain } : { kind: TASK_BODY.detailed, text: task.body },
  ...activityFacts(task),
  hold: task.hold === null ? { kind: TASK_HOLD.none } : { kind: TASK_HOLD.held, ...task.hold },
  owner: task.owner,
  runs_in: task.runs_in,
  token_budget:
    task.token_budget === null
      ? { kind: TOKEN_CAP.uncapped }
      : { kind: TOKEN_CAP.capped, tokens: task.token_budget },
  due: task.due_at === null ? { kind: TASK_DUE.none } : { kind: TASK_DUE.due, at: task.due_at },
  next_attempt:
    task.next_attempt_at === null
      ? { kind: TASK_NEXT_ATTEMPT.none }
      : { kind: TASK_NEXT_ATTEMPT.at, at: task.next_attempt_at },
  created_at: task.created_at,
  updated_at: task.updated_at,
  created_by:
    task.created_by === null
      ? { kind: TASK_CREATOR.unrecorded }
      : { kind: TASK_CREATOR.recorded, by: task.created_by },
  seq:
    task.seq === null ? { kind: TASK_SEQ.unnumbered } : { kind: TASK_SEQ.numbered, seq: task.seq },
  block_count: task.block_count,
  sources: task.sources.map(publicSource),
  capture: task.capture,
  contract: task.contract.map(publicLine),
  state:
    task.state === null
      ? { kind: TASK_STATE.unwritten }
      : {
          kind: TASK_STATE.written,
          ...task.state,
          in_progress: task.state.in_progress.map((job) => ({
            what: job.what,
            handle:
              job.handle === undefined
                ? { kind: JOB_HANDLE.untracked }
                : { kind: JOB_HANDLE.tracked, handle: job.handle }
          }))
        }
})

export const publicTask = (task: TaskRecord): SpaceTask => {
  const fields = taskFields(task)
  switch (task.status) {
    case TASK_STATUS.open:
    case TASK_STATUS.deferred:
      return { ...fields, status: task.status }
    case TASK_STATUS.done:
    case TASK_STATUS.cancelled:
      return { ...fields, status: task.status, completed_at: task.completed_at ?? task.updated_at }
  }
}

export const publicComment = ({ space_id, ...comment }: TaskCommentRecord): SpaceTaskComment => ({
  ...comment,
  space: taskSpace(space_id)
})

export const publicAttachment = ({
  space_id,
  ...attachment
}: TaskAttachmentRecord): SpaceTaskAttachment => ({ ...attachment, space: taskSpace(space_id) })

const publicEvent = ({
  space_id,
  item_id,
  run_ref,
  ...event
}: TaskEventRecord): SpaceTaskEvent => ({
  ...event,
  space: taskSpace(space_id),
  item: item_id === null ? { kind: EVENT_ITEM.space_wide } : { kind: EVENT_ITEM.item, item_id },
  run: run_ref === null ? { kind: EVENT_RUN.none } : { kind: EVENT_RUN.run, run_ref }
})

const publicResult = ({ summary, source, ...result }: TaskResultRecord): SpaceTaskResult => ({
  ...result,
  summary:
    summary === null
      ? { kind: RESULT_SUMMARY.none }
      : { kind: RESULT_SUMMARY.summary, text: summary },
  source:
    source.kind === RESULT_SOURCE.event
      ? source
      : { kind: source.kind, attempt_id: source.attempt_id, run: runRef(source.run_id) }
})

const publicRunState = (run: TaskRunRecord): SpaceTaskRun["run"] => {
  if (run.run_id === null || run.started_at === null) return { kind: TASK_RUN.none }
  const started = {
    run_id: run.run_id,
    chat_run: runRef(run.chat_run_id),
    started_at: run.started_at
  }
  return run.running || run.ended_at === null
    ? { kind: TASK_RUN.running, ...started }
    : {
        kind: TASK_RUN.ended,
        ...started,
        ended_at: run.ended_at,
        result:
          run.result === null
            ? { kind: RUN_RESULT.none }
            : { kind: RUN_RESULT.result, text: run.result }
      }
}

const publicRun = (run: TaskRunRecord): SpaceTaskRun => ({
  attempt_count: run.attempt_count,
  item_id: run.item_id,
  session_id: run.session_id,
  run: publicRunState(run)
})

export const publicSnapshot = (snapshot: SnapshotRecord): SpaceSnapshot => ({
  results: snapshot.results.map(publicResult),
  work_items: snapshot.work_items.map(publicTask),
  events: snapshot.events.map(publicEvent),
  comments: snapshot.comments.map(publicComment),
  attachments: snapshot.attachments.map(publicAttachment)
})

export const publicPage = (page: WorkPageRecord): SpaceWorkPage => ({
  items: page.items.map(publicTask),
  events: page.events.map(publicEvent),
  comments: page.comments.map(publicComment),
  attachments: page.attachments.map(publicAttachment),
  runs: page.runs.map(publicRun),
  results: page.results.map(publicResult),
  approvals: page.approvals,
  next:
    page.next_cursor === null
      ? { kind: PAGE_NEXT.end }
      : { kind: PAGE_NEXT.more, cursor: page.next_cursor }
})

export const publicStop = (stop: StopTaskRecord): StopSpaceTaskResponse => ({
  ...stop,
  task: publicTask(stop.task)
})
