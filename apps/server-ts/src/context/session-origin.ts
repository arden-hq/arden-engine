import { CHAT_SENT_FROM } from "@arden-hq/protocol/chat"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ChatRunnerMessage } from "../chat/runner-contract.js"
import type { AutomationOriginPolicy } from "../persistence/automations/catalog.js"
import type { AutomationId } from "../persistence/automations/model.js"
import { isSpaceWorkJob } from "../persistence/job-classification.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"
import type { AgentMode } from "../sessions/agent-mode.js"
import type { SpecialChat } from "./special-chat.js"

export const SESSION_ORIGIN_SOURCE = {
  personal: "personal",
  agent: "agent",
  scheduledTask: "scheduled_task"
} as const

export type SessionOrigin =
  | {
      readonly source: typeof SESSION_ORIGIN_SOURCE.personal
      readonly header: SessionHistoryHeader | null
      readonly starting: string | undefined
      readonly special: SpecialChat | undefined
    }
  | {
      readonly source: typeof SESSION_ORIGIN_SOURCE.agent
      readonly mode: AgentMode
      readonly header: SessionHistoryHeader
    }
  | {
      readonly source: typeof SESSION_ORIGIN_SOURCE.scheduledTask
      readonly automationId: AutomationId
      readonly policy: AutomationOriginPolicy
      readonly header: SessionHistoryHeader
      readonly fork: boolean
      readonly ownRun: boolean
    }

export const isLiveChat = (
  origin: SessionOrigin,
  messages: ReadonlyArray<ChatRunnerMessage>,
  userFacing: boolean
): boolean => {
  if (origin.source !== SESSION_ORIGIN_SOURCE.personal || !userFacing) return false
  const latest = messages.findLast((message) => message.role === ROLE.user)
  return !(latest !== undefined && "sent_from" in latest && latest.sent_from === CHAT_SENT_FROM.cli)
}

export const omittedSkills = (origin: SessionOrigin): ReadonlyArray<string> =>
  origin.source === SESSION_ORIGIN_SOURCE.scheduledTask && !isSpaceWorkJob(origin.policy)
    ? ["work-coordination", "automation-design"]
    : []
