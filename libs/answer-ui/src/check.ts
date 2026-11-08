import { formatBytes } from "@arden-hq/std/count"
import type { ASTNode, ParseResult } from "@openuidev/lang-core"
import { ANSWER_UI_MAX_BYTES } from "./fence.js"
import { formulaIssues } from "./formula-check.js"
import { readBlock, type Statement } from "./read.js"
import { readToolResult, TOOL_RESULT_QUERY, toolResultMissText } from "./tool-result.js"

/** One problem in a block: the line it starts on (1-based, when known) and
 *  what is wrong, worded for the model that wrote it. */
export interface BlockIssue {
  readonly line: number | undefined
  readonly message: string
}

const MAX_TREE_BYTES = 256 * 1024
const MAX_PARSE_MS = 1000

export interface CheckOptions {
  readonly now?: () => number
  /** The result text of a tool call the model saw in this chat, or undefined
   *  when it saw none with that id. Without it, a `Query("tool_result", …)`
   *  is checked for its shape only. */
  readonly toolResult?: (callId: string) => string | undefined
}

/** Check one `arden:ui` block body the way the renderer will read it, plus the
 *  rules the renderer cannot enforce: state starts as a literal and is declared
 *  before the statements that use it; data comes only from a read of this
 *  chat's tool results, and nothing is written; every formula reads and
 *  names only its vars. No issues means the block
 *  draws whole. */
export function checkAnswerBlock(
  source: string,
  { now = Date.now, toolResult }: CheckOptions = {}
): ReadonlyArray<BlockIssue> {
  const started = now()
  const read = readBlock(source)
  switch (read.kind) {
    case "too_large":
      return [
        {
          line: undefined,
          message: `The block is over ${formatBytes(ANSWER_UI_MAX_BYTES)} and is shown as code. Split it or show less.`
        }
      ]
    case "unreadable":
      return [{ line: undefined, message: "The block could not be read. Rewrite it more simply." }]
    case "expands":
      return [
        {
          line: undefined,
          message:
            "References expand too far: statements that each reuse another one several times multiply. Compute values once and reuse fewer references."
        }
      ]
    case "parsed":
      break
  }
  const { parsed, statements } = read
  if (now() - started > MAX_PARSE_MS || JSON.stringify(parsed.root ?? null).length > MAX_TREE_BYTES)
    return [{ line: undefined, message: "The block is too large to draw. Show less in it." }]
  const lineOf = (id: string | undefined) =>
    id === undefined ? undefined : statements.find((statement) => statement.id === id)?.line
  return [
    ...(parsed.root === null
      ? [{ line: undefined, message: "The block has no `root = Stack([...])` line." }]
      : []),
    ...parsed.meta.errors.map((error) => ({
      line: lineOf(error.statementId),
      message: error.message
    })),
    ...parsed.meta.unresolved.map((name) => ({
      line: undefined,
      message: `\`${name}\` is used but never defined, so it draws nothing.`
    })),
    ...statements
      .filter((statement) => statement.computed)
      .map(({ id, line }) => ({
        line,
        message: `\`${id}\` is state set from an expression. State starts as a literal; write a derived value as a plain statement (\`${id.slice(1)} = …\`) instead.`
      })),
    ...usedBeforeDeclared(statements).map(({ statement, state }) => ({
      line: statement.line,
      message: `\`${statement.id}\` uses \`${state}\` before \`${state} = …\` is declared. Put every $state line first, right after root.`
    })),
    ...parsed.mutationStatements.map((mutation) => ({
      line: lineOf(mutation.statementId),
      message: `\`${mutation.statementId}\` is a Mutation. A block never changes anything; use a Button whose text asks for the change instead.`
    })),
    ...formulaIssues(parsed.root).map(({ statementId, message }) => ({
      line: lineOf(statementId),
      message
    })),
    ...parsed.queryStatements.flatMap((query) =>
      queryIssues(query, toolResult).map((message) => ({
        line: lineOf(query.statementId),
        message: `\`${query.statementId}\`: ${message}`
      }))
    )
  ]
}

type QueryStatement = ParseResult["queryStatements"][number]

const QUERY_SHAPE = `write \`Query("${TOOL_RESULT_QUERY}", {call: "<tool call id>", path: "<field.path>"}, <default>)\``

function queryIssues(
  query: QueryStatement,
  toolResult: CheckOptions["toolResult"]
): ReadonlyArray<string> {
  const tool = literalString(query.toolAST)
  if (tool !== TOOL_RESULT_QUERY)
    return [
      `a block reads only tool results already in this chat; it cannot call ${tool === undefined ? "a tool" : `\`${tool}\``}. Call the tool yourself first, then ${QUERY_SHAPE}.`
    ]
  const args = queryArgs(query.argsAST)
  if (args === undefined) return [`the call id and path must be plain strings: ${QUERY_SHAPE}.`]
  const issues =
    query.refreshAST === null ? [] : ["a tool result never changes; drop the refresh interval."]
  if (toolResult === undefined) return issues
  const result = toolResult(args.call)
  if (result === undefined)
    return [...issues, `${toolResultMissText("no_call")} (\`${args.call}\`).`]
  const read = readToolResult(result, args.path)
  return read.status === "value"
    ? issues
    : [...issues, `${toolResultMissText(read.reason)} (\`${args.path}\`).`]
}

const literalString = (node: ASTNode | null | undefined): string | undefined =>
  node?.k === "Str" ? node.v : undefined

function queryArgs(
  node: ASTNode | null
): { readonly call: string; readonly path: string } | undefined {
  if (node?.k !== "Obj") return undefined
  const fields = new Map(node.entries)
  if ([...fields.keys()].some((key) => key !== "call" && key !== "path")) return undefined
  const call = literalString(fields.get("call"))
  const path = fields.has("path") ? literalString(fields.get("path")) : ""
  return call === undefined || call.length === 0 || path === undefined ? undefined : { call, path }
}

function usedBeforeDeclared(
  statements: ReadonlyArray<Statement>
): ReadonlyArray<{ readonly statement: Statement; readonly state: string }> {
  return statements.flatMap((statement, index) =>
    statement.isState || statement.id === "root"
      ? []
      : [...new Set(statement.states)].flatMap((state) => {
          const declared = statements.findIndex((other) => other.id === state)
          return declared > index ? [{ statement, state }] : []
        })
  )
}
