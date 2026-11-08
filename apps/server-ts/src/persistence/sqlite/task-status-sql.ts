import { Statement } from "effect/unstable/sql"

const column = (alias: string | undefined): string =>
  alias === undefined ? "status" : `${alias}.status`

const fragment = (text: string): Statement.Fragment => Statement.fragment([Statement.literal(text)])

export const taskOpenSql = (alias?: string): Statement.Fragment =>
  fragment(`${column(alias)} = 'open'`)

export const taskUnfinishedSql = (alias?: string): Statement.Fragment =>
  fragment(`${column(alias)} IN ('open', 'deferred')`)
