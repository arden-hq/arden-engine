import { Context } from "effect"
import type { RunCapability } from "../../execution/policy.js"
import type { HandlerItemInput } from "../automations/handler-item.js"
import type { NewAgentSessionMetadata } from "../../sessions/agent-mode.js"
import type { StoredMessageEnvelope } from "../transcript/model.js"
import type { AutomationId } from "../automations/model.js"

export class ChatRules extends Context.Service<
  ChatRules,
  {
    readonly acceptMessage: (input: {
      readonly message: StoredMessageEnvelope
      readonly elapsedMs: number | null
    }) => StoredMessageEnvelope
    readonly agentAssignment: (agent: NewAgentSessionMetadata, task: string) => string
    readonly researchWorkspaceId: (rootSessionId: string) => string
    readonly automationCapabilities: (automationId: AutomationId) => ReadonlyArray<RunCapability>
    readonly handlerItemPrompt: (input: HandlerItemInput) => string
  }
>()("@arden-hq/server/persistence/chat/ChatRules") {}
