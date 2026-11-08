import { Layer } from "effect"
import { handlerItemPrompt, systemHandlerForAutomation } from "../automations/system.js"
import { withIdleGapContext } from "../context/idle-gap.js"
import { ChatRules } from "../persistence/chat/rules.js"
import { renderAgentRolePrompt } from "../prompts/agent-role.js"
import { researchWorkspaceId } from "../research/workspace.js"

export const chatRulesLayer: Layer.Layer<ChatRules> = Layer.succeed(
  ChatRules,
  ChatRules.of({
    acceptMessage: withIdleGapContext,
    agentAssignment: renderAgentRolePrompt,
    researchWorkspaceId,
    automationCapabilities: (automationId) =>
      systemHandlerForAutomation(automationId)?.extraCapabilities ?? [],
    handlerItemPrompt
  })
)
