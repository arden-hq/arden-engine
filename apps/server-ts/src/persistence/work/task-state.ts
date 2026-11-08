import type {
  TaskStateRecordPatch,
  TaskStateRejected,
  TaskStateRunning
} from "@arden-hq/protocol/spaces/work"
import { Effect, Schema } from "effect"

export interface TaskStateRecord {
  readonly done: ReadonlyArray<string>
  readonly in_progress: ReadonlyArray<TaskStateRunning>
  readonly decided: ReadonlyArray<string>
  readonly rejected: ReadonlyArray<TaskStateRejected>
  readonly next: ReadonlyArray<string>
  readonly written_at: string
  readonly run_id: string | null
  readonly added?: TaskStateAdded
}

export interface TaskStateAdded {
  readonly done: ReadonlyArray<string>
  readonly decided: ReadonlyArray<string>
}

const TaskStateRecordSchema = Schema.Struct({
  done: Schema.Array(Schema.String),
  in_progress: Schema.Array(
    Schema.Struct({ what: Schema.String, handle: Schema.optionalKey(Schema.String) })
  ),
  decided: Schema.Array(Schema.String),
  rejected: Schema.Array(Schema.Struct({ option: Schema.String, why: Schema.String })),
  next: Schema.Array(Schema.String),
  written_at: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  added: Schema.optionalKey(
    Schema.Struct({ done: Schema.Array(Schema.String), decided: Schema.Array(Schema.String) })
  )
})

const TaskStateRecordJsonSchema = Schema.fromJsonString(TaskStateRecordSchema)

export const readTaskState = Effect.fn("TaskState.read")(function* (
  stored: string | null
): Effect.fn.Return<TaskStateRecord | undefined> {
  if (stored === null) return undefined
  return yield* Schema.decodeUnknownEffect(TaskStateRecordJsonSchema)(stored).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Task state record does not decode", cause).pipe(Effect.as(undefined))
    )
  )
})

type TaskStateSections = Omit<TaskStateRecord, "written_at" | "run_id" | "added">

const addedBy = (
  previous: TaskStateRecord | undefined,
  sections: TaskStateSections,
  runId: string | undefined
): TaskStateAdded => {
  const again = previous !== undefined && runId !== undefined && previous.run_id === runId
  const found = (section: "done" | "decided") =>
    (previous?.[section] ?? []).filter(
      (line) => !(again && (previous.added?.[section] ?? []).includes(line))
    )
  const base = { done: found("done"), decided: found("decided") }
  return {
    done: sections.done.filter((line) => !base.done.includes(line)),
    decided: sections.decided.filter((line) => !base.decided.includes(line))
  }
}

export const taskStateWrite = Effect.fn("TaskState.write")(function* (
  stored: string | null,
  patch: TaskStateRecordPatch,
  runId: string | undefined
): Effect.fn.Return<(TaskStateSections & { readonly added: TaskStateAdded }) | undefined> {
  const previous = yield* readTaskState(stored)
  const sections = {
    done: patch.done ?? previous?.done ?? [],
    in_progress: patch.in_progress ?? previous?.in_progress ?? [],
    decided: patch.decided ?? previous?.decided ?? [],
    rejected: patch.rejected ?? previous?.rejected ?? [],
    next: patch.next ?? previous?.next ?? []
  }
  const written = { ...sections, added: addedBy(previous, sections, runId) }
  if (previous === undefined) return written
  const { written_at: _at, run_id: _run, added: _added, ...held } = previous
  return JSON.stringify(sectionsInOrder(held)) === JSON.stringify(sections) ? undefined : written
})

const sectionsInOrder = (sections: TaskStateSections): TaskStateSections => ({
  done: sections.done,
  in_progress: sections.in_progress.map((job) =>
    job.handle === undefined ? { what: job.what } : { what: job.what, handle: job.handle }
  ),
  decided: sections.decided,
  rejected: sections.rejected.map((option) => ({ option: option.option, why: option.why })),
  next: sections.next
})

export const stampTaskState = (
  sections: TaskStateSections & { readonly added: TaskStateAdded },
  stamp: { readonly at: string; readonly runId: string | undefined }
): string => JSON.stringify({ ...sections, written_at: stamp.at, run_id: stamp.runId ?? null })

export interface TaskStateView {
  readonly record: TaskStateRecord
  readonly sessionRef: string | undefined
  readonly laterWakes: number
}
