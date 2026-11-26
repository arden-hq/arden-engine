import {
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_SUBJECT,
  WORDS_RULE_REPLACES,
  type PermissionPathAccess
} from "@arden-hq/protocol/permissions"
import { homedir } from "node:os"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { tooWide } from "../../fs/protected-paths.js"
import type { SqlClient } from "effect/unstable/sql"
import {
  RULE_SOURCE,
  RULE_CHANGE,
  PermissionRules,
  PermissionRulesError,
  RuleInputSchema,
  RuleSubjectSchema,
  type PermissionRule,
  type PermissionRulesOperation,
  type RuleChange,
  type RuleInput,
  type RuleList,
  type RuleSource,
  type RuleSubject,
  type WordsInput,
  wordsRuleText
} from "../permissions/rules.js"
import { nextId, type PersistenceDeps } from "./deps.js"

interface RuleRow {
  readonly rule_id: string
  readonly list_kind: RuleList["kind"]
  readonly space_id: string | null
  readonly subject_kind: Exclude<RuleSubject["kind"], typeof PERMISSION_RULE_SUBJECT.site>
  readonly tool_name: string | null
  readonly server_name: string | null
  readonly executable_path: string | null
  readonly argument_prefix_json: string | null
  readonly words: string | null
  readonly origin: string | null
  readonly path: string | null
  readonly access: PermissionPathAccess | null
  readonly key_name: string | null
  readonly key_id: string | null
  readonly decision: PermissionRule["decision"]
  readonly source_kind: PermissionRule["source"]["kind"]
  readonly source_run_id: string | null
  readonly created_at: string | null
  readonly from_rule_id: string | null
}

const COLUMNS = `rule_id, list_kind, space_id, subject_kind, tool_name, server_name, executable_path,
  argument_prefix_json, words, origin, path, access, key_name, key_id, decision, source_kind, source_run_id, created_at, from_rule_id`

const error = (
  operation: PermissionRulesOperation,
  reason: PermissionRulesError["reason"],
  message: string,
  cause?: unknown
) =>
  new PermissionRulesError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const storage = (operation: PermissionRulesOperation, message: string) => (cause: unknown) =>
  cause instanceof PermissionRulesError ? cause : error(operation, "storage", message, cause)

const ArgumentsJsonSchema = Schema.fromJsonString(Schema.Array(Schema.NonEmptyString))

const ruleFromRow = Effect.fn("SqlitePermissionRules.fromRow")(function* (row: RuleRow) {
  const corrupt = (cause: unknown) => error("list", "storage", "A stored rule is corrupt", cause)
  const argumentPrefix =
    row.argument_prefix_json === null
      ? undefined
      : yield* Schema.decodeUnknownEffect(ArgumentsJsonSchema)(row.argument_prefix_json).pipe(
          Effect.mapError(corrupt)
        )
  const site = row.subject_kind === PERMISSION_RULE_SUBJECT.tool && row.origin !== null
  const subject = yield* Schema.decodeUnknownEffect(RuleSubjectSchema)({
    kind: site ? PERMISSION_RULE_SUBJECT.site : row.subject_kind,
    tool: row.tool_name ?? undefined,
    origin: row.origin ?? undefined,
    server: site
      ? undefined
      : (row.server_name ?? (row.subject_kind === PERMISSION_RULE_SUBJECT.tool ? null : undefined)),
    executable: row.executable_path ?? undefined,
    argumentPrefix,
    text: row.words ?? undefined,
    path: row.path ?? undefined,
    access: row.access ?? undefined,
    name: row.key_name ?? undefined,
    keyId: row.key_id ?? undefined
  }).pipe(Effect.mapError(corrupt))
  const list: RuleList =
    row.list_kind === PERMISSION_RULE_LIST.space && row.space_id !== null
      ? { kind: "space", spaceId: row.space_id }
      : {
          kind:
            row.list_kind === PERMISSION_RULE_LIST.system
              ? PERMISSION_RULE_LIST.system
              : PERMISSION_RULE_LIST.global
        }
  return {
    id: row.rule_id,
    subject,
    list,
    decision: row.decision,
    source: { kind: row.source_kind, runId: row.source_run_id },
    createdAt: row.created_at,
    fromRuleId: row.from_rule_id
  } satisfies PermissionRule
})

const rulesFromRows = (rows: ReadonlyArray<RuleRow>) => Effect.forEach(rows, ruleFromRow)

const identity = (input: Pick<RuleInput, "subject" | "list">) => {
  const { subject, list } = input
  return {
    list_kind: list.kind,
    space_id: list.kind === PERMISSION_RULE_LIST.space ? list.spaceId : null,
    subject_kind:
      subject.kind === PERMISSION_RULE_SUBJECT.site ? PERMISSION_RULE_SUBJECT.tool : subject.kind,
    tool_name:
      subject.kind === PERMISSION_RULE_SUBJECT.tool || subject.kind === PERMISSION_RULE_SUBJECT.site
        ? subject.tool
        : null,
    server_name:
      subject.kind === PERMISSION_RULE_SUBJECT.tool ||
      subject.kind === PERMISSION_RULE_SUBJECT.connector
        ? subject.server
        : null,
    executable_path: subject.kind === PERMISSION_RULE_SUBJECT.command ? subject.executable : null,
    argument_prefix_json:
      subject.kind === PERMISSION_RULE_SUBJECT.command
        ? JSON.stringify(subject.argumentPrefix)
        : null,
    words: subject.kind === PERMISSION_RULE_SUBJECT.words ? subject.text : null,
    origin: subject.kind === PERMISSION_RULE_SUBJECT.site ? subject.origin : null,
    path: subject.kind === PERMISSION_RULE_SUBJECT.path ? subject.path : null,
    access: subject.kind === PERMISSION_RULE_SUBJECT.path ? subject.access : null,
    key_name: subject.kind === PERMISSION_RULE_SUBJECT.vaultKey ? subject.name : null,
    key_id: subject.kind === PERMISSION_RULE_SUBJECT.vaultKey ? subject.keyId : null
  }
}

export const saveRuleInTransaction = Effect.fn("SqlitePermissionRules.saveInTransaction")(
  function* (sql: SqlClient.SqlClient, raw: RuleInput) {
    const input = yield* Schema.decodeUnknownEffect(RuleInputSchema)(raw).pipe(
      Effect.mapError((cause) => error("save", "invalid", "Invalid permission rule", cause))
    )
    if (
      input.subject.kind === PERMISSION_RULE_SUBJECT.hostCommands &&
      input.decision !== PERMISSION_RULE_DECISION.ask
    )
      return yield* error("save", "invalid", "Commands on your Mac can only be set to ask")
    if (
      input.subject.kind === PERMISSION_RULE_SUBJECT.path &&
      input.decision !== PERMISSION_RULE_DECISION.never
    ) {
      const files = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list
        WHERE name = 'main'`
      const file = files[0]?.file ?? ""
      const stateRoots = file === "" ? [] : [path.dirname(file)]
      if (tooWide(input.subject.path, { stateRoots, home: homedir() }))
        return yield* error("save", "invalid", "That folder is too wide to allow")
    }
    if (
      input.subject.kind === PERMISSION_RULE_SUBJECT.path &&
      input.decision === PERMISSION_RULE_DECISION.ask
    )
      return yield* error("save", "invalid", "A folder rule allows or never")
    const key = identity(input)
    if (key.server_name !== null) {
      const server = yield* sql<{ readonly name: string }>`SELECT name FROM mcp_servers
        WHERE name = ${key.server_name}`
      if (server.length === 0)
        return yield* error("save", "not_found", "That connector is no longer connected")
    }
    const source = input.source
    const sourceRun = source.kind === RULE_SOURCE.card ? source.runId : null
    const sourceCall = source.kind === RULE_SOURCE.card ? source.toolCallId : null
    const sourceQuestion = source.kind === RULE_SOURCE.offer ? source.questionId : null
    const now = DateTime.formatIso(yield* DateTime.now)
    const existing = yield* sql<RuleRow>`SELECT ${sql.unsafe(COLUMNS)} FROM permission_rules
      WHERE list_kind = ${key.list_kind} AND space_id IS ${key.space_id}
        AND subject_kind = ${key.subject_kind} AND tool_name IS ${key.tool_name}
        AND executable_path IS ${key.executable_path}
        AND argument_prefix_json IS ${key.argument_prefix_json} AND words IS ${key.words}
        AND origin IS ${key.origin} AND path IS ${key.path} AND access IS ${key.access}
        AND key_id IS ${key.key_id}
        AND (subject_kind != 'connector' OR server_name IS ${key.server_name})`
    const held = existing[0]
    const from = input.fromRuleId ?? null
    if (held !== undefined && (held.decision === input.decision || from !== null))
      return yield* ruleFromRow(held)
    const rows =
      held === undefined
        ? yield* sql<RuleRow>`INSERT INTO permission_rules (
            rule_id, list_kind, space_id, subject_kind, tool_name, server_name, executable_path,
            argument_prefix_json, words, origin, path, access, key_name, key_id, decision, source_kind,
            source_run_id, source_tool_call_id, source_question_id, created_at, from_rule_id
          ) VALUES (
            ${yield* nextId}, ${key.list_kind}, ${key.space_id}, ${key.subject_kind},
            ${key.tool_name}, ${key.server_name}, ${key.executable_path}, ${key.argument_prefix_json}, ${key.words}, ${key.origin}, ${key.path}, ${key.access}, ${key.key_name}, ${key.key_id}, ${input.decision},
            ${source.kind}, ${sourceRun}, ${sourceCall}, ${sourceQuestion}, ${now}, ${from}
          ) RETURNING ${sql.unsafe(COLUMNS)}`
        : yield* sql<RuleRow>`UPDATE permission_rules SET decision = ${input.decision},
            source_kind = ${source.kind}, source_run_id = ${sourceRun},
            source_tool_call_id = ${sourceCall}, source_question_id = ${sourceQuestion},
            created_at = ${now}
          WHERE rule_id = ${held.rule_id} RETURNING ${sql.unsafe(COLUMNS)}`
    const row = rows[0]
    if (row === undefined) return yield* error("save", "storage", "The rule was not saved")
    return yield* ruleFromRow(row)
  },
  (effect) => effect.pipe(Effect.mapError(storage("save", "Could not save the permission rule")))
)

export const saveWordsInTransaction = Effect.fn("SqlitePermissionRules.saveWordsInTransaction")(
  function* (sql: SqlClient.SqlClient, input: WordsInput) {
    if (input.replaces.kind === WORDS_RULE_REPLACES.rule) {
      const replaced = yield* sql<{
        readonly subject_kind: RuleRow["subject_kind"]
      }>`SELECT subject_kind
        FROM permission_rules WHERE rule_id = ${input.replaces.rule_id}`
      if (replaced[0]?.subject_kind !== PERMISSION_RULE_SUBJECT.words)
        return yield* error("save", "not_found", "That rule was not found")
      yield* changeRuleInTransaction(sql, {
        ruleId: input.replaces.rule_id,
        decision: "remove",
        source: input.source,
        list: input.list
      })
    }
    const words = yield* saveRuleInTransaction(sql, {
      subject: { kind: "words", text: wordsRuleText(input.text) },
      list: input.list,
      decision: input.decision,
      source: input.source
    })
    yield* sql`DELETE FROM permission_rules WHERE from_rule_id = ${words.id}`
    for (const rule of input.rules) {
      if (
        rule.decision === PERMISSION_RULE_DECISION.allow &&
        (yield* allowOverrides(sql, { subject: rule.subject, list: input.list }))
      )
        continue
      yield* saveRuleInTransaction(sql, {
        subject: rule.subject,
        list: input.list,
        decision: rule.decision,
        source: input.source,
        fromRuleId: words.id
      })
    }
    return words
  },
  (effect) => effect.pipe(Effect.mapError(storage("save", "Could not save the rule")))
)

export const changeRuleInTransaction = Effect.fn("SqlitePermissionRules.changeInTransaction")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly ruleId: string
      readonly decision: RuleChange
      readonly source: RuleSource
      readonly list?: RuleList
    }
  ) {
    const operation = input.decision === RULE_CHANGE.remove ? "remove" : "save"
    const rows = yield* sql<RuleRow>`SELECT ${sql.unsafe(COLUMNS)} FROM permission_rules
      WHERE rule_id = ${input.ruleId}`
    const held = rows[0] === undefined ? undefined : yield* ruleFromRow(rows[0])
    if (held === undefined || (input.list !== undefined && !sameRuleList(held.list, input.list)))
      return yield* error(operation, "not_found", "That rule was not found")
    if (input.decision === RULE_CHANGE.remove) {
      yield* sql`DELETE FROM permission_rules WHERE rule_id = ${input.ruleId}`
      return held
    }
    const saved = yield* saveRuleInTransaction(sql, {
      subject: held.subject,
      list: held.list,
      decision: input.decision,
      source: input.source
    })
    if (held.subject.kind === PERMISSION_RULE_SUBJECT.words) {
      const children = yield* sql<RuleRow>`SELECT ${sql.unsafe(COLUMNS)} FROM permission_rules
        WHERE from_rule_id = ${held.id}`
      yield* sql`DELETE FROM permission_rules WHERE from_rule_id = ${held.id}`
      const decision = input.decision
      for (const row of children) {
        const child = yield* ruleFromRow(row)
        if (
          child.subject.kind === PERMISSION_RULE_SUBJECT.path &&
          decision === PERMISSION_RULE_DECISION.ask
        )
          continue
        if (
          decision === PERMISSION_RULE_DECISION.allow &&
          (yield* allowOverrides(sql, { subject: child.subject, list: held.list }))
        )
          continue
        yield* saveRuleInTransaction(sql, {
          subject: child.subject,
          list: held.list,
          decision,
          source: input.source,
          fromRuleId: held.id
        })
      }
    }
    return saved
  },
  (effect) => effect.pipe(Effect.mapError(storage("save", "Could not change the permission rule")))
)

const sameRuleList = (left: RuleList, right: RuleList): boolean =>
  left.kind === right.kind &&
  (left.kind !== PERMISSION_RULE_LIST.space ||
    (right.kind === PERMISSION_RULE_LIST.space && left.spaceId === right.spaceId))

const allowOverrides = Effect.fn("SqlitePermissionRules.allowOverrides")(
  function* (sql: SqlClient.SqlClient, input: Pick<RuleInput, "subject" | "list">) {
    const key = identity(input)
    const held = yield* sql<{ readonly rule_id: string }>`SELECT rule_id FROM permission_rules
      WHERE (subject_kind = ${key.subject_kind} AND tool_name IS ${key.tool_name}
          AND executable_path IS ${key.executable_path}
          AND argument_prefix_json IS ${key.argument_prefix_json} AND words IS ${key.words}
          AND origin IS ${key.origin}
          AND (subject_kind != 'connector' OR server_name IS ${key.server_name})
          AND ((list_kind = ${key.list_kind} AND space_id IS ${key.space_id})
            OR (list_kind = 'global' AND decision != 'allow')))
        OR (${key.origin} IS NOT NULL AND subject_kind = 'tool' AND tool_name = ${key.tool_name}
          AND origin IS NULL
          AND ((list_kind = ${key.list_kind} AND space_id IS ${key.space_id})
            OR (list_kind = 'global' AND decision != 'allow')))
        OR (${key.list_kind} != 'global' AND list_kind = 'global' AND decision != 'allow'
          AND server_name = ${key.server_name}
          AND ((${key.subject_kind} = 'connector' AND subject_kind = 'tool')
            OR (${key.subject_kind} = 'tool' AND subject_kind = 'connector')))
      LIMIT 1`
    return held.length > 0
  },
  (effect) => effect.pipe(Effect.mapError(storage("list", "Could not read the rules")))
)

export const allowsSave = Effect.fn("SqlitePermissionRules.allowsSave")(function* (
  sql: SqlClient.SqlClient,
  input: Pick<RuleInput, "list"> & { readonly subjects: ReadonlyArray<RuleInput["subject"]> }
) {
  for (const subject of input.subjects)
    if (yield* allowOverrides(sql, { subject, list: input.list })) return false
  return true
})

export const saveAllowsInTransaction = Effect.fn("SqlitePermissionRules.saveAllowsInTransaction")(
  function* (
    sql: SqlClient.SqlClient,
    input: Omit<RuleInput, "decision" | "subject"> & {
      readonly subjects: ReadonlyArray<RuleInput["subject"]>
    }
  ) {
    if (!(yield* allowsSave(sql, input))) return false
    for (const subject of input.subjects)
      yield* saveRuleInTransaction(sql, {
        subject,
        list: input.list,
        source: input.source,
        decision: "allow"
      })
    return true
  }
)

const rulesInLists = Effect.fn("SqlitePermissionRules.inLists")(
  function* (sql: SqlClient.SqlClient, lists: ReadonlyArray<RuleList>) {
    const spaces = lists.flatMap((list) =>
      list.kind === PERMISSION_RULE_LIST.space ? [list.spaceId] : []
    )
    const rows = yield* sql<RuleRow>`SELECT ${sql.unsafe(COLUMNS)} FROM permission_rules
      WHERE (list_kind = 'global' AND ${lists.some((list) => list.kind === PERMISSION_RULE_LIST.global) ? 1 : 0})
        OR (list_kind = 'system' AND ${lists.some((list) => list.kind === PERMISSION_RULE_LIST.system) ? 1 : 0})
        OR (list_kind = 'space' AND ${spaces.length === 0 ? sql`0` : sql.in("space_id", spaces)})
      ORDER BY rule_id`
    return yield* rulesFromRows(rows)
  },
  (effect) => effect.pipe(Effect.mapError(storage("list", "Could not read permission rules")))
)

export const makePermissionRules = ({
  writer
}: Pick<PersistenceDeps, "writer">): PermissionRules["Service"] => {
  const sql = writer.sql
  const list = Effect.fn("SqlitePermissionRules.list")(function* () {
    const rows = yield* sql<RuleRow>`SELECT ${sql.unsafe(COLUMNS)} FROM permission_rules
      ORDER BY created_at IS NULL, created_at DESC, rule_id DESC`.pipe(
      Effect.mapError(storage("list", "Could not list permission rules"))
    )
    return yield* rulesFromRows(rows)
  })

  const inLists = (lists: ReadonlyArray<RuleList>) => rulesInLists(sql, lists)

  const save = (input: RuleInput) =>
    writer
      .transact(saveRuleInTransaction(sql, input))
      .pipe(Effect.mapError(storage("save", "Could not save the permission rule")))

  const change = (input: Parameters<PermissionRules["Service"]["change"]>[0]) =>
    writer
      .transact(changeRuleInTransaction(sql, input))
      .pipe(Effect.mapError(storage("save", "Could not change the permission rule")))

  const saveWords = (input: WordsInput) =>
    writer
      .transact(saveWordsInTransaction(sql, input))
      .pipe(Effect.mapError(storage("save", "Could not save the rule")))

  return PermissionRules.of({ list, inLists, save, saveWords, change })
}
