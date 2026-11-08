/**
 * What a model call was for, named for what the owner would recognise, not for
 * the code that made it (ledger agent-upgrades, D2). `usage_daily.kind` holds
 * exactly this set.
 * - `chat`: a Run — a chat turn, an Automation run or a sub-agent; the rollup's
 *   `origin` and `session_type` split them further.
 * - `chat_title`: naming a new chat (and a capture chat from Arden's answer).
 * - `run_activity`: describing a running task when its agent supplied no purpose.
 * - `letter_subject`: the subject line of a Space letter.
 * - `chat_triage`: deciding which Space a loose chat belongs on.
 * - `focus_offer`: the objective of a focused chat Arden offers to open.
 * - `space_overview`: the Space overview made from its chats' summaries.
 * - `space_instructions`, `automation_description`, `recipe_draft`: the text
 *   a Generate button writes.
 * - `capture`: routing a handed screenshot to the chat it belongs in.
 * - `item_routing`: routing new mail and GitHub items, and a finished chat, to the Space they belong on.
 * - `helper_review`: the Helper judging a tool call in Auto approval mode.
 * - `claim_check`: checking a research claim against its source.
 * - `compaction`: the handoff summary that replaces a chat's older context.
 * - `automation_prefilter`: asking whether an event that woke an Automation
 *   matches its pre-filter, before a run starts.
 * - `space_review_gate`: asking whether a Space review would find anything to do,
 *   before its run starts.
 * - `composer_shortcut`: reading words in the composer as a rule, a Task or a
 *   question about earlier work, and writing the card that offers it.
 */
export const MODEL_CALL_KINDS = [
  "chat",
  "chat_title",
  "run_activity",
  "letter_subject",
  "chat_triage",
  "focus_offer",
  "space_overview",
  "space_instructions",
  "automation_description",
  "recipe_draft",
  "capture",
  "item_routing",
  "helper_review",
  "claim_check",
  "compaction",
  "automation_prefilter",
  "space_review_gate",
  "composer_shortcut"
] as const

export type ModelCallKind = (typeof MODEL_CALL_KINDS)[number]

/**
 * The product groups the Usage report shows (D2):
 * - `chats`: Runs the owner started.
 * - `automations`: Runs scheduled work started, and the checks that may skip them.
 * - `upkeep`: the small calls that keep chats and Spaces tidy.
 * - `safety`: the Helper judging tool calls, and claim checks.
 */
export type UsageGroup = "chats" | "automations" | "upkeep" | "safety"

/** The product group a model call's spend belongs to. */
export const usageGroup = (kind: ModelCallKind, origin: "user" | "automation"): UsageGroup => {
  switch (kind) {
    case "chat":
      return origin === "automation" ? "automations" : "chats"
    case "automation_prefilter":
    case "space_review_gate":
      return "automations"
    case "chat_title":
    case "run_activity":
    case "letter_subject":
    case "chat_triage":
    case "focus_offer":
    case "space_overview":
    case "space_instructions":
    case "automation_description":
    case "recipe_draft":
    case "capture":
    case "item_routing":
    case "compaction":
    case "composer_shortcut":
      return "upkeep"
    case "helper_review":
    case "claim_check":
      return "safety"
  }
}
