import type { SpaceTaskStatus } from "@arden-hq/protocol/spaces/work"
import { Statement } from "effect/unstable/sql"

/** A Task that can still take work: open, or deferred to later. */
export const UNFINISHED_TASK_STATUSES = [
  "open",
  "deferred"
] as const satisfies ReadonlyArray<SpaceTaskStatus>

const column = (alias: string | undefined): string =>
  alias === undefined ? "status" : `${alias}.status`

const fragment = (text: string): Statement.Fragment => Statement.fragment([Statement.literal(text)])

export const taskOpenSql = (alias?: string): Statement.Fragment =>
  fragment(`${column(alias)} = 'open'`)

export const taskUnfinishedSql = (alias?: string): Statement.Fragment =>
  fragment(
    `${column(alias)} IN (${UNFINISHED_TASK_STATUSES.map((status) => `'${status}'`).join(", ")})`
  )
