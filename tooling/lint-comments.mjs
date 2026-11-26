import { COMMENT_KIND } from "./value-tables.mjs"

const scriptFile = /\.(?:js|mjs|cjs)$/
const typeTag = /^@(?:type|typedef|param|returns?|template|satisfies|import|property|prop|callback|overload|this|enum|extends|implements)\b/
const citesSource = /https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])\S+|\b[\w.-]+\/[\w.-]+#\d+\b|\bcrbug\s+\d+|\bRFC\s?\d+\b/
const licenseHeader = /^(?:\*\s*)?(?:@license|SPDX-License-Identifier:|Copyright\b)/
const formatterIgnore = /^(?:prettier|oxfmt)-ignore\b/

export const allowedComment = (comment, filename) => {
  if (comment.type === COMMENT_KIND.Shebang) return true
  const text = comment.value.trim()
  if (citesSource.test(text) || licenseHeader.test(text) || formatterIgnore.test(text)) return true
  if (/^(?:oxlint|eslint)-(?:disable|enable)\S*\s.*\s--\s+\S/.test(text)) return true
  if (/^@ts-expect-error\s+\S/.test(text)) return true
  if (comment.type === COMMENT_KIND.Line && /^\/\s*<reference(?:\s+(?:types|path|lib|no-default-lib|preserve|resolution-mode)=(["'])[^"']*\1)+\s*\/>\s*$/.test(comment.value)) return true
  if (comment.type !== COMMENT_KIND.Block ||!comment.value.startsWith("*") || !scriptFile.test(filename)) return false
  const lines = comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter((line) => line !== "")
  let depth = 0
  for (const line of lines) {
    if (depth === 0 && !typeTag.test(line)) return false
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }
  return lines.length > 0
}

export const noCommentsMessage =
  "No comments in code: put the reason in the commit message or the PR. Allowed: a comment that cites its source (an issue, RFC or vendor link) for a constraint code cannot express, a license header, a `#!` shebang line, `prettier-ignore`, `oxlint-disable… -- reason`, `@ts-expect-error reason`, and JSDoc type tags in .js/.mjs/.cjs files"
