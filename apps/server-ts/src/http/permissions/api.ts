import {
  CommandSandboxStatusSchema,
  DefaultApprovalModeSchema,
  NewPermissionRuleSchema,
  PermissionIdSchema,
  PermissionRuleDecisionPatchSchema,
  PermissionRuleListResponseSchema,
  NewWordsRuleSchema,
  PermissionWordsCompiledSchema,
  PermissionWordsSchema,
  SessionPermissionPatchRequestSchema,
  SessionPermissionSchema
} from "@arden-hq/protocol/effect/permissions"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { storeErrors } from "../errors.js"

export class PermissionsApi extends HttpApiGroup.make("permissions", { topLevel: true }).add(
  HttpApiEndpoint.get("session", "/permissions/sessions/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    success: SessionPermissionSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.patch("setSession", "/permissions/sessions/:sessionId", {
    params: { sessionId: Schema.NonEmptyString },
    payload: SessionPermissionPatchRequestSchema,
    success: SessionPermissionSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("defaultMode", "/permissions/default-mode", {
    success: DefaultApprovalModeSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.put("setDefaultMode", "/permissions/default-mode", {
    payload: DefaultApprovalModeSchema,
    success: DefaultApprovalModeSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.get("rules", "/permissions/rules", {
    success: PermissionRuleListResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("spaceRules", "/permissions/rules/spaces/:spaceId", {
    params: { spaceId: PermissionIdSchema },
    success: PermissionRuleListResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.post("saveRule", "/permissions/rules", {
    payload: NewPermissionRuleSchema,
    success: PermissionRuleListResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("compileWords", "/permissions/rules/compile", {
    payload: PermissionWordsSchema,
    success: PermissionWordsCompiledSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.post("saveWords", "/permissions/rules/words", {
    payload: NewWordsRuleSchema,
    success: PermissionRuleListResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.patch("decideRule", "/permissions/rules/:ruleId", {
    params: { ruleId: PermissionIdSchema },
    payload: PermissionRuleDecisionPatchSchema,
    success: PermissionRuleListResponseSchema,
    error: [HttpApiError.BadRequestNoContent, ...storeErrors]
  }),
  HttpApiEndpoint.delete("removeRule", "/permissions/rules/:ruleId", {
    params: { ruleId: PermissionIdSchema },
    success: PermissionRuleListResponseSchema,
    error: storeErrors
  }),
  HttpApiEndpoint.get("commandSandbox", "/permissions/command-sandbox", {
    success: CommandSandboxStatusSchema
  })
) {}
