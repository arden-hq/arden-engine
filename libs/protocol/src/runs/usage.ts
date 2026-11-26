export const MODEL_CALL_KIND = {
  chat: "chat",
  chatTitle: "chat_title",
  runActivity: "run_activity",
  letterSubject: "letter_subject",
  chatTriage: "chat_triage",
  focusOffer: "focus_offer",
  spaceOverview: "space_overview",
  spaceInstructions: "space_instructions",
  automationDescription: "automation_description",
  recipeDraft: "recipe_draft",
  capture: "capture",
  itemRouting: "item_routing",
  helperReview: "helper_review",
  claimCheck: "claim_check",
  compaction: "compaction",
  automationPrefilter: "automation_prefilter",
  spaceReviewGate: "space_review_gate",
  composerShortcut: "composer_shortcut"
} as const

export type ModelCallKind = (typeof MODEL_CALL_KIND)[keyof typeof MODEL_CALL_KIND]

export const USAGE_ORIGIN = { user: "user", automation: "automation" } as const

export type UsageOrigin = (typeof USAGE_ORIGIN)[keyof typeof USAGE_ORIGIN]

export const USAGE_GROUP = {
  chats: "chats",
  automations: "automations",
  upkeep: "upkeep",
  safety: "safety"
} as const

export type UsageGroup = (typeof USAGE_GROUP)[keyof typeof USAGE_GROUP]

const SUPPORT_CALL_GROUP: Readonly<
  Record<Exclude<ModelCallKind, typeof MODEL_CALL_KIND.chat>, UsageGroup>
> = {
  automation_prefilter: USAGE_GROUP.automations,
  space_review_gate: USAGE_GROUP.automations,
  chat_title: USAGE_GROUP.upkeep,
  run_activity: USAGE_GROUP.upkeep,
  letter_subject: USAGE_GROUP.upkeep,
  chat_triage: USAGE_GROUP.upkeep,
  focus_offer: USAGE_GROUP.upkeep,
  space_overview: USAGE_GROUP.upkeep,
  space_instructions: USAGE_GROUP.upkeep,
  automation_description: USAGE_GROUP.upkeep,
  recipe_draft: USAGE_GROUP.upkeep,
  capture: USAGE_GROUP.upkeep,
  item_routing: USAGE_GROUP.upkeep,
  compaction: USAGE_GROUP.upkeep,
  composer_shortcut: USAGE_GROUP.upkeep,
  helper_review: USAGE_GROUP.safety,
  claim_check: USAGE_GROUP.safety
}

export const usageGroup = (kind: ModelCallKind, origin: UsageOrigin): UsageGroup => {
  if (kind !== MODEL_CALL_KIND.chat) return SUPPORT_CALL_GROUP[kind]
  return origin === USAGE_ORIGIN.automation ? USAGE_GROUP.automations : USAGE_GROUP.chats
}
