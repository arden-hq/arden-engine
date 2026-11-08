import { checkAnswerBlock, type BlockIssue, type CheckOptions } from "@arden-hq/answer-ui/check"
import { ANSWER_UI_FENCE } from "@arden-hq/answer-ui/fence"
import { answerBlockBodies, answerBlockFences } from "@arden-hq/protocol/chat"

const MAX_LISTED_ISSUES = 12

export const answerBlockCorrection = (
  text: string,
  toolResult?: CheckOptions["toolResult"]
): string | undefined => {
  const blocks = answerBlockBodies(text)
  const problems = [...nestedBlockProblems(text)]
  problems.push(
    ...blocks.flatMap((body, index) =>
      checkAnswerBlock(body, toolResult === undefined ? {} : { toolResult }).map((issue) =>
        issueLine(blocks.length > 1 ? index + 1 : undefined, issue)
      )
    )
  )
  if (problems.length === 0) return undefined
  const listed = problems.slice(0, MAX_LISTED_ISSUES)
  const more = problems.length - listed.length
  return [
    `Your answer has \`${ANSWER_UI_FENCE}\` ${blocks.length > 1 ? "blocks" : "a block"} that will not draw as written; the broken parts are dropped:`,
    ...listed.map((problem) => `- ${problem}`),
    ...(more > 0 ? [`- …and ${more} more.`] : []),
    "Write your whole final answer again with these fixed. Keep everything else as it was, and do not mention the fix."
  ].join("\n")
}

const nestedBlockProblems = (text: string): ReadonlyArray<string> => {
  const fences = answerBlockFences(text)
  return fences.flatMap((fence, index) =>
    fence.nested
      ? [
          `${fences.length > 1 ? `Block ${index + 1}` : "The block"} is inside a list item or a quote. Write it at the top level of the answer, between paragraphs, and put the list or quote text beside it.`
        ]
      : []
  )
}

const issueLine = (block: number | undefined, issue: BlockIssue): string => {
  const where = [
    ...(block === undefined ? [] : [`Block ${block}`]),
    ...(issue.line === undefined ? [] : [`line ${issue.line}`])
  ].join(", ")
  return where.length === 0 ? issue.message : `${capitalize(where)}: ${issue.message}`
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
