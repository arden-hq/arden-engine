import type { PermissionRuleDecision } from "./contracts.js"

/**
 * Every word Arden uses for a permission decision, and the action sentences a
 * rule names, in one place. The desktop, the server's cards and the prompts all read
 * them from here; a lint rule (`noDecisionLiterals`) and `check:decision-words`
 * keep a second spelling out.
 */
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

/** A rule's decision as its row, its menu and its group name it. */
export const RULE_DECISION_WORD: Record<PermissionRuleDecision, string> = {
  allow: DECISION_WORD.allow,
  ask: DECISION_WORD.ask,
  never: DECISION_WORD.deny
}

/** A rule's decision as a question offering to keep it: "Always deny …?". */
export const STANDING_DECISION_WORD: Record<PermissionRuleDecision, string> = {
  allow: DECISION_WORD.alwaysAllow,
  ask: DECISION_WORD.alwaysAsk,
  never: DECISION_WORD.alwaysDeny
}

/** What a rule does, as its sentence starts: "Use GitHub", "Run git push". */
export const RULE_ACTION = {
  use: "Use",
  run: "Run",
  hostCommands: "Run commands on your Mac"
} as const

/** What a folder rule does with the folder's files, as a rule sentence starts. */
export const PATH_ACTION: Record<"read" | "change", string> = {
  read: "Read files in",
  change: "Change files in"
}

/** The same, as a question asks it: "Always allow reading files in ~/x?". */
export const PATH_DOING: Record<"read" | "change", string> = {
  read: "reading files in",
  change: "changing files in"
}
