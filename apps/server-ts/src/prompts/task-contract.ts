import { CONTRACT_CHANGE } from "../persistence/work/contract.js"
import { CONTRACT_LINE } from "@arden-hq/protocol/spaces/work"
import {
  evidenceWords,
  type ContractChange,
  type ContractLine,
  type TaskContract
} from "../persistence/work/contract.js"
import { PROMPTS } from "./catalog.js"
import { renderPromptSection } from "./format.js"

const KIND_HEADING: Record<ContractLine["kind"], string> = {
  rule: "Rules",
  criterion: "Done when",
  decision: "Decisions"
}

export const renderTaskContract = (contract: TaskContract): string | undefined => {
  if (contract.lines.length === 0) return undefined
  const groups = (["rule", "criterion", "decision"] as const).flatMap((kind) => {
    const lines = contract.lines.filter((line) => line.kind === kind)
    return lines.length === 0 ? [] : [`${KIND_HEADING[kind]}:`, ...lines.map(lineEntry)]
  })
  return renderPromptSection("Task contract", [PROMPTS.taskContract, ...groups].join("\n"))
}

const lineEntry = (line: ContractLine): string => {
  const source = `saved by the owner from message ${line.sourceMessageId}`
  const rejected =
    line.kind === CONTRACT_LINE.decision && line.rejected !== undefined
      ? ` Rejected: ${JSON.stringify(line.rejected)}.`
      : ""
  return `- L${line.lineId}: ${JSON.stringify(line.text)} (${source}).${rejected}`
}

export const renderTaskProgress = (contract: TaskContract): string | undefined => {
  const criteria = contract.lines.flatMap((line) =>
    line.kind === CONTRACT_LINE.criterion ? [line] : []
  )
  if (criteria.length === 0 && contract.pending.length === 0) return undefined
  return renderPromptSection(
    "Task progress",
    [
      ...(criteria.length === 0
        ? []
        : [
            "Done-when criteria by the evidence Arden's server recorded. Only recorded evidence meets a criterion; task_finish refuses while one is unmet.",
            ...criteria.map((line) =>
              line.evidence.length === 0
                ? `- L${line.lineId}: not met`
                : `- L${line.lineId}: met by ${line.evidence.map((entry) => evidenceWords(entry.evidence)).join("; ")}`
            )
          ]),
      ...(contract.pending.length === 0
        ? []
        : [
            "Proposed, waiting for the owner's answer; do not propose these again:",
            ...contract.pending.map(
              (pending) => `- ${changeWords(pending.change)} (question ${pending.questionId})`
            )
          ])
    ].join("\n")
  )
}

const changeWords = (change: ContractChange): string => {
  switch (change.kind) {
    case CONTRACT_CHANGE.add:
      return `add ${change.line.kind} ${JSON.stringify(change.line.text)}${change.replaces === undefined ? "" : `, replacing L${change.replaces}`}`
    case CONTRACT_CHANGE.retire:
      return `remove L${change.line_id}`
  }
}
