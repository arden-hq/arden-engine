import { Schema } from "effect"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { HandlerItemRefSchema } from "../automations/handler-item.js"
import { AutomationId } from "../automations/model.js"
import { JsonObjectSchema } from "../json.js"
import { ApprovalModeSchema } from "@arden-hq/protocol/effect/permissions"

export const chatAdmissionInputSchema = Schema.Struct({
  wake: Schema.optionalKey(Schema.Boolean),
  approvalReply: Schema.optionalKey(
    Schema.Struct({ runId: Schema.NonEmptyString, toolId: Schema.NonEmptyString })
  ),
  deliveryId: Schema.optionalKey(Schema.NonEmptyString),
  admittedWith: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  sessionId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  requestHash: Schema.NonEmptyString,
  assistantMessageId: Schema.NonEmptyString,
  message: StoredMessageEnvelopeSchema,
  approvalMode: Schema.optionalKey(ApprovalModeSchema),
  outputSchema: Schema.optionalKey(JsonObjectSchema),
  modelId: Schema.optionalKey(Schema.NonEmptyString),
  modelRole: Schema.optionalKey(Schema.Literals(["background", "helper"] as const)),
  announce: Schema.optionalKey(Schema.Literal(true)),
  automation: Schema.optionalKey(
    Schema.Struct({
      attemptId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      automationId: AutomationId,
      name: Schema.NonEmptyString
    })
  ),
  automationPrompt: Schema.optionalKey(Schema.NonEmptyString),
  automationContextMode: Schema.optionalKey(
    Schema.Literals(["fresh", "continue", "fork"] as const)
  ),
  handlerItem: Schema.optionalKey(HandlerItemRefSchema),
  automationLease: Schema.optionalKey(
    Schema.Struct({ id: Schema.NonEmptyString, token: Schema.NonEmptyString })
  ),
  continuesTask: Schema.optionalKey(Schema.Struct({ itemId: Schema.NonEmptyString })),
  fromQueue: Schema.optionalKey(Schema.Literal(true)),
  capture: Schema.optionalKey(
    Schema.Struct({
      via: Schema.Literals(["screenshot", "quick", "phone"] as const),
      note: Schema.String,
      screenshot: Schema.Boolean
    })
  )
}).check(
  Schema.makeFilter((input) => {
    const issues: Array<Schema.FilterIssue> = []
    if (
      input.continuesTask !== undefined &&
      (input.automation !== undefined || input.deliveryId !== undefined)
    ) {
      issues.push({ path: ["continuesTask"], issue: "is a turn of its own" })
    }
    if (input.handlerItem !== undefined && input.automation === undefined) {
      issues.push({ path: ["handlerItem"], issue: "requires an Automation" })
    }
    if (input.modelId !== undefined && input.modelRole !== undefined) {
      issues.push({ path: ["modelId"], issue: "cannot be combined with modelRole" })
    }
    if (input.message.role !== "user") {
      issues.push({ path: ["message", "role"], issue: "must be a user message" })
    }
    if (input.message.message_id !== input.clientId) {
      issues.push({ path: ["message", "message_id"], issue: "must equal clientId" })
    }
    if (input.message.client_id !== input.clientId) {
      issues.push({ path: ["message", "client_id"], issue: "must equal clientId" })
    }
    const hasAutomationContext =
      input.automation !== undefined && input.automationPrompt !== undefined
    if ((input.automation === undefined) !== (input.automationLease === undefined)) {
      issues.push({
        path: ["automationLease"],
        issue: "must be present exactly when Automation identity is present"
      })
    }
    if ((input.automation === undefined) !== (input.automationPrompt === undefined)) {
      issues.push({
        path: ["automationPrompt"],
        issue: "must be present exactly when Automation identity is present"
      })
    }
    if ((input.automation === undefined) !== (input.automationContextMode === undefined)) {
      issues.push({
        path: ["automationContextMode"],
        issue: "must be present exactly when Automation identity is present"
      })
    }
    if (hasAutomationContext && input.message.automation === undefined) {
      issues.push({ path: ["message", "automation"], issue: "is required for an Automation" })
    }
    if (!hasAutomationContext && input.message.automation !== undefined) {
      issues.push({ path: ["message", "automation"], issue: "requires Automation context" })
    }
    return issues
  })
)
