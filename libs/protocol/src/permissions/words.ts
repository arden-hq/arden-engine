import type { PermissionPathAccess, PermissionRuleDecision } from "./contracts.js"

export const DECISION_WORD = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
  allowOnce: "Allow once",
  alwaysAllow: "Always allow",
  alwaysAsk: "Always ask before",
  alwaysDeny: "Always deny",
  allowed: "Allowed",
  denied: "Denied"
} as const

export type DecisionWord = (typeof DECISION_WORD)[keyof typeof DECISION_WORD]

export const RULE_DECISION_WORD: Record<PermissionRuleDecision, DecisionWord> = {
  allow: DECISION_WORD.allow,
  ask: DECISION_WORD.ask,
  never: DECISION_WORD.deny
}

export const STANDING_DECISION_WORD: Record<PermissionRuleDecision, DecisionWord> = {
  allow: DECISION_WORD.alwaysAllow,
  ask: DECISION_WORD.alwaysAsk,
  never: DECISION_WORD.alwaysDeny
}

export const RULE_ACTION = {
  use: "Use",
  run: "Run",
  hostCommands: "Run commands on your Mac"
} as const

export type RuleAction = (typeof RULE_ACTION)[keyof typeof RULE_ACTION]

export const PATH_ACTION: Record<PermissionPathAccess, string> = {
  read: "Read files in",
  change: "Change files in"
}

export const PATH_DOING: Record<PermissionPathAccess, string> = {
  read: "reading files in",
  change: "changing files in"
}
