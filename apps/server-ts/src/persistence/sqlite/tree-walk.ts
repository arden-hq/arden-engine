import type { SqlClient, Statement } from "effect/unstable/sql"

interface Walk<Sql = Statement.Fragment> {
  readonly name: string
  readonly from: Sql
  readonly where?: Sql
  readonly depth?: { readonly max: number }
  readonly root?: true
  readonly limit?: number
}

export const sessionDescendants = (sql: SqlClient.SqlClient, walk: Walk) =>
  cte(fragments(sql), walk, steps.sessionDescendants)

export const sessionAncestors = (sql: SqlClient.SqlClient, walk: Walk) =>
  cte(fragments(sql), walk, steps.sessionAncestors)

export const sessionAncestorsText = (walk: Walk<string>): string =>
  cte(text, walk, steps.sessionAncestors)

export const runDescendants = (sql: SqlClient.SqlClient, walk: Walk) =>
  cte(fragments(sql), walk, steps.runDescendants)

export const runAncestors = (sql: SqlClient.SqlClient, walk: Walk) =>
  cte(fragments(sql), walk, steps.runAncestors)

export const delegatedLinkSql = (sql: SqlClient.SqlClient) => sql`EXISTS (
  SELECT 1 FROM chat_runs AS delegating_run
  WHERE delegating_run.run_id = child.parent_run_id
    AND delegating_run.session_id = child.parent_session_id)`

interface Step {
  readonly id: "session_id" | "run_id"
  readonly next: string
  readonly join: string
  readonly link?: string
}

const steps = {
  sessionDescendants: {
    id: "session_id",
    next: "child.session_id",
    join: "JOIN sessions AS child ON child.parent_session_id = walk.session_id"
  },
  sessionAncestors: {
    id: "session_id",
    next: "parent.session_id",
    join: `JOIN sessions AS child ON child.session_id = walk.session_id
      JOIN sessions AS parent ON parent.session_id = child.parent_session_id`
  },
  runDescendants: {
    id: "run_id",
    next: "run.run_id",
    join: `JOIN sessions AS child ON child.parent_run_id = walk.run_id
      JOIN chat_runs AS run ON run.session_id = child.session_id`
  },
  runAncestors: {
    id: "run_id",
    next: "child.parent_run_id",
    join: `JOIN chat_runs AS run ON run.run_id = walk.run_id
      JOIN sessions AS child ON child.session_id = run.session_id`,
    link: "child.parent_run_id IS NOT NULL"
  }
} as const satisfies Record<string, Step>

interface Rendering<Sql> {
  readonly value: (value: number) => Sql
  readonly and: (clauses: ReadonlyArray<Sql | string>) => Sql
  readonly concat: (parts: ReadonlyArray<Sql | string>) => Sql
}

const fragments = (sql: SqlClient.SqlClient): Rendering<Statement.Fragment> => ({
  value: (value) => sql`${value}`,
  and: sql.and,
  concat: sql.join("", false)
})

const text: Rendering<string> = {
  value: String,
  and: (clauses) => {
    if (clauses.length === 0) return "1=1"
    if (clauses.length === 1) return clauses[0] ?? "1=1"
    return `(${clauses.join(" AND ")})`
  },
  concat: (parts) => parts.join("")
}

const cte = <Sql>(render: Rendering<Sql>, walk: Walk<Sql>, step: Step): Sql => {
  const id = step.id
  const tracked = [
    ...(walk.depth === undefined ? [] : ["depth"]),
    ...(walk.root === undefined ? [] : [`root_${id}`])
  ]
  const start = [
    ...(walk.depth === undefined ? [] : ["0"]),
    ...(walk.root === undefined ? [] : [`start.${id}`])
  ]
  const next = [
    ...(walk.depth === undefined ? [] : ["walk.depth + 1"]),
    ...(walk.root === undefined ? [] : [`walk.root_${id}`])
  ]
  const max = walk.depth?.max
  const conditions = [
    ...(step.link === undefined ? [] : [step.link]),
    ...(walk.where === undefined ? [] : [render.concat(["(", walk.where, ")"])]),
    ...(max === undefined ? [] : [render.concat(["walk.depth < ", render.value(max)])])
  ]
  const columns = (first: string, rest: ReadonlyArray<string>) => [first, ...rest].join(", ")
  return render.concat([
    `${walk.name}(${columns(id, tracked)}) AS (
      SELECT ${columns(`start.${id}`, start)} FROM (`,
    walk.from,
    `) AS start
      UNION
      SELECT ${columns(step.next, next)} FROM ${walk.name} AS walk
      ${step.join}
      WHERE `,
    render.and(conditions),
    ...(walk.limit === undefined ? [] : [" LIMIT ", render.value(walk.limit)]),
    `
    )`
  ])
}
