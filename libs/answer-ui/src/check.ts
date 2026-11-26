import { formatBytes } from "@arden-hq/std/count"
import type { ASTNode, ParseResult } from "@openuidev/lang-core"
import { AST_KIND } from "./ast.js"
import { ANSWER_UI_MAX_BYTES } from "./fence.js"
import { formulaIssues } from "./formula-check.js"
import { BLOCK_READ_KIND, readBlock, ROOT_STATEMENT, type Statement } from "./read.js"
import {
  readToolResult,
  TOOL_RESULT_QUERY,
  TOOL_RESULT_STATUS,
  TOOL_RESULT_VALUE_MISS,
  toolResultMissText
} from "./tool-result.js"

export interface BlockIssue {
  readonly line: number | undefined
  readonly message: string
}

const MAX_TREE_BYTES = 256 * 1024
const MAX_PARSE_MS = 1000

export interface CheckOptions {
  readonly now?: () => number
  readonly toolResult?: (callId: string) => string | undefined
}

export function checkAnswerBlock(
  source: string,
  { now = Date.now, toolResult }: CheckOptions = {}
): ReadonlyArray<BlockIssue> {
  const started = now()
  const read = readBlock(source)
  switch (read.kind) {
    case BLOCK_READ_KIND.tooLarge:
      return [
        {
          line: undefined,
          message: `The block is over ${formatBytes(ANSWER_UI_MAX_BYTES)} and is shown as code. Split it or show less.`
        }
      ]
    case BLOCK_READ_KIND.unreadable:
      return [{ line: undefined, message: "The block could not be read. Rewrite it more simply." }]
    case BLOCK_READ_KIND.expands:
      return [
        {
          line: undefined,
          message:
            "References expand too far: statements that each reuse another one several times multiply. Compute values once and reuse fewer references."
        }
      ]
    case BLOCK_READ_KIND.parsed:
      break
  }
  const { parsed, statements } = read
  if (now() - started > MAX_PARSE_MS || JSON.stringify(parsed.root ?? null).length > MAX_TREE_BYTES)
    return [{ line: undefined, message: "The block is too large to draw. Show less in it." }]
  const lineOf = (name: string | undefined) =>
    name === undefined ? undefined : statements.find((statement) => statement.name === name)?.line
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
      .map(({ name, line }) => ({
        line,
        message: `\`${name}\` is state set from an expression. State starts as a literal; write a derived value as a plain statement (\`${name.slice(1)} = …\`) instead.`
      })),
    ...usedBeforeDeclared(statements).map(({ statement, state }) => ({
      line: statement.line,
      message: `\`${statement.name}\` uses \`${state}\` before \`${state} = …\` is declared. Put every $state line first, right after root.`
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
    return [...issues, `${toolResultMissText(TOOL_RESULT_VALUE_MISS.noCall)} (\`${args.call}\`).`]
  const read = readToolResult(result, args.path)
  return read.status === TOOL_RESULT_STATUS.value
    ? issues
    : [...issues, `${toolResultMissText(read.reason)} (\`${args.path}\`).`]
}

const literalString = (node: ASTNode | null | undefined): string | undefined =>
  node?.k === AST_KIND.Str ? node.v : undefined

const QUERY_ARG = { call: "call", path: "path" } as const
type QueryArg = (typeof QUERY_ARG)[keyof typeof QUERY_ARG]
const QUERY_ARGS: ReadonlySet<string> = new Set<QueryArg>(Object.values(QUERY_ARG))
const isQueryArg = (key: string): key is QueryArg => QUERY_ARGS.has(key)

function queryArgs(
  node: ASTNode | null
): { readonly call: string; readonly path: string } | undefined {
  if (node?.k !== AST_KIND.Obj) return undefined
  const fields = new Map(node.entries)
  if (![...fields.keys()].every(isQueryArg)) return undefined
  const call = literalString(fields.get(QUERY_ARG.call))
  const path = fields.has(QUERY_ARG.path) ? literalString(fields.get(QUERY_ARG.path)) : ""
  return call === undefined || call.length === 0 || path === undefined ? undefined : { call, path }
}

function usedBeforeDeclared(
  statements: ReadonlyArray<Statement>
): ReadonlyArray<{ readonly statement: Statement; readonly state: string }> {
  return statements.flatMap((statement, index) =>
    statement.isState || statement.name === ROOT_STATEMENT
      ? []
      : [...new Set(statement.states)].flatMap((state) => {
          const declared = statements.findIndex((other) => other.name === state)
          return declared > index ? [{ statement, state }] : []
        })
  )
}
