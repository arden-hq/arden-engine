import { decoderFor, runBoundary } from "../common/boundary.js"
import {
  SessionPermissionSchema,
  DefaultApprovalModeSchema,
  PermissionRuleListResponseSchema,
  CommandSandboxStatusSchema,
  PermissionWordsCompiledSchema,
  encodePermissionRulePathEffect,
  encodeSpaceRulesPathEffect
} from "./schema.js"

export * from "./contracts.js"
export * from "./modes.js"
export * from "./words.js"

export const permissionDecoders = {
  session: decoderFor(SessionPermissionSchema, "Invalid session permission response"),
  defaultMode: decoderFor(DefaultApprovalModeSchema, "Invalid default approval mode response"),
  rules: decoderFor(PermissionRuleListResponseSchema, "Invalid permission rules response"),
  commandSandbox: decoderFor(CommandSandboxStatusSchema, "Invalid command sandbox response"),
  wordsCompiled: decoderFor(PermissionWordsCompiledSchema, "Invalid compiled rule response")
} as const

/** Build validated paths for the complete permissions HTTP surface. */
export const permissionRoutes = {
  rules: "/permissions/rules",
  compileWords: "/permissions/rules/compile",
  saveWords: "/permissions/rules/words",
  commandSandbox: "/permissions/command-sandbox",
  defaultMode: "/permissions/default-mode",
  session: (sessionId: string): string => `/permissions/sessions/${encodeURIComponent(sessionId)}`,
  spaceRules(spaceId: string): string {
    return runBoundary(encodeSpaceRulesPathEffect(spaceId), "Invalid Space rules route", "encode")
  },
  rule(id: string): string {
    return runBoundary(
      encodePermissionRulePathEffect(id),
      "Invalid permission rule route",
      "encode"
    )
  }
} as const
