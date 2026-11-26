import {
  AUTOMATION_PROMPT,
  RUN_CAUSE,
  type AgentResult,
  type AutomationPrompt,
  type ChatUpdate,
  type InteractionSender,
  type RunCause
} from "@arden-hq/protocol/chat"
import type { AutomationContextMode } from "@arden-hq/protocol/automations"
import { startedBy } from "./interaction.js"

interface CauseAutomation {
  readonly automationId: string
  readonly name: string
}

const automationCause = (
  automation: CauseAutomation,
  contextMode: AutomationContextMode,
  prompt: AutomationPrompt
): RunCause => ({
  kind: RUN_CAUSE.automation,
  task_id: automation.automationId,
  name: automation.name,
  prompt,
  context_mode: contextMode
})

export const delegatedCauses = (
  automation: CauseAutomation | null,
  contextMode: AutomationContextMode | null
): ReadonlyArray<RunCause> =>
  automation === null || contextMode === null
    ? []
    : [automationCause(automation, contextMode, { kind: AUTOMATION_PROMPT.delegated })]

export const runCauses = (input: {
  readonly questionAnswer: { readonly question_id: string } | undefined
  readonly agentResult: AgentResult | undefined
  readonly sender: InteractionSender | undefined
  readonly content: unknown
  readonly update: ChatUpdate | undefined
  readonly automation:
    | (CauseAutomation & { readonly prompt: string; readonly contextMode: AutomationContextMode })
    | undefined
}): ReadonlyArray<RunCause> => [
  ...(input.questionAnswer === undefined
    ? []
    : [{ kind: RUN_CAUSE.questionAnswer, question_id: input.questionAnswer.question_id }]),
  ...(input.agentResult === undefined
    ? []
    : [{ kind: RUN_CAUSE.agentResult, agent_result: input.agentResult }]),
  ...startedBy(input.sender, input.content),
  ...(input.update === undefined ? [] : [{ kind: RUN_CAUSE.update, update: input.update }]),
  ...(input.automation === undefined
    ? []
    : [
        automationCause(input.automation, input.automation.contextMode, {
          kind: AUTOMATION_PROMPT.own,
          text: input.automation.prompt
        })
      ])
]
