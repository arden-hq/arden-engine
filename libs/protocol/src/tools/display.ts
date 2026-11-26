import { Schema } from "effect"

export const TOOL_DISPLAY_MAIL = {
  send: "send",
  reply: "reply",
  forward: "forward",
  draft: "draft"
} as const

export const TOOL_DISPLAY_CARD = {
  command: "command",
  fileChange: "file_change",
  siteGrant: "site_grant",
  siteSecret: "site_secret",
  vaultKeyUse: "vault_key_use",
  vaultKeyAsk: "vault_key_ask",
  vaultCardPay: "vault_card_pay",
  vaultCardFrame: "vault_card_frame",
  pagePatch: "page_patch",
  automation: "automation",
  calendar: "calendar"
} as const

export const TOOL_DISPLAY_RESULT = {
  appliedEdit: "applied_edit",
  automationCreated: "automation_created",
  savedArtifact: "saved_artifact",
  chatSent: "chat_sent",
  toolList: "tool_list"
} as const

export const TOOL_DISPLAY_REFRESH = { automations: "automations", terminals: "terminals" } as const

export const TOOL_DISPLAY_ROW = {
  code: "code",
  webSites: "web_sites",
  chatRead: "chat_read",
  skill: "skill",
  report: "report",
  blocked: "blocked"
} as const

export const TOOL_DISPLAY_TRAIL = { hidden: "hidden", plan: "plan" } as const

export const TOOL_DISPLAY_APP = { tour: "tour" } as const

export type ToolDisplayMail = (typeof TOOL_DISPLAY_MAIL)[keyof typeof TOOL_DISPLAY_MAIL]
export type ToolDisplayCard = (typeof TOOL_DISPLAY_CARD)[keyof typeof TOOL_DISPLAY_CARD]
export type ToolDisplayResult = (typeof TOOL_DISPLAY_RESULT)[keyof typeof TOOL_DISPLAY_RESULT]
export type ToolDisplayRefresh = (typeof TOOL_DISPLAY_REFRESH)[keyof typeof TOOL_DISPLAY_REFRESH]
export type ToolDisplayRow = (typeof TOOL_DISPLAY_ROW)[keyof typeof TOOL_DISPLAY_ROW]
export type ToolDisplayTrail = (typeof TOOL_DISPLAY_TRAIL)[keyof typeof TOOL_DISPLAY_TRAIL]
export type ToolDisplayApp = (typeof TOOL_DISPLAY_APP)[keyof typeof TOOL_DISPLAY_APP]

export const TOOL_DISPLAY_FACTS = {
  mail: Object.values(TOOL_DISPLAY_MAIL),
  card: Object.values(TOOL_DISPLAY_CARD),
  result: Object.values(TOOL_DISPLAY_RESULT),
  refresh: Object.values(TOOL_DISPLAY_REFRESH),
  row: Object.values(TOOL_DISPLAY_ROW),
  trail: Object.values(TOOL_DISPLAY_TRAIL),
  app: Object.values(TOOL_DISPLAY_APP)
} as const

type Facts = typeof TOOL_DISPLAY_FACTS

export type ToolDisplayFact = {
  readonly [Fact in keyof Facts]: { readonly fact: Fact; readonly value: Facts[Fact][number] }
}[keyof Facts]

export type ToolDisplay = ReadonlyArray<ToolDisplayFact>

export const toolDisplayFact = <Fact extends keyof Facts>(
  display: ToolDisplay | undefined,
  fact: Fact
): Facts[Fact][number] | undefined =>
  display?.find(
    (each): each is Extract<ToolDisplayFact, { readonly fact: Fact }> => each.fact === fact
  )?.value

const APP_ONLY_CARDS: ReadonlyArray<ToolDisplayCard> = [
  TOOL_DISPLAY_CARD.siteSecret,
  TOOL_DISPLAY_CARD.vaultKeyAsk,
  TOOL_DISPLAY_CARD.vaultCardPay,
  TOOL_DISPLAY_CARD.vaultCardFrame
]

export const grantedOnlyInTheApp = (display: ToolDisplay | undefined): boolean => {
  const card = toolDisplayFact(display, "card")
  return APP_ONLY_CARDS.some((each) => each === card)
}

const factSchema = <const Fact extends keyof Facts>(fact: Fact) =>
  Schema.Struct({ fact: Schema.Literal(fact), value: Schema.Literals(TOOL_DISPLAY_FACTS[fact]) })

export const ToolDisplaySchema = Schema.Array(
  Schema.Union([
    factSchema("mail"),
    factSchema("card"),
    factSchema("result"),
    factSchema("refresh"),
    factSchema("row"),
    factSchema("trail"),
    factSchema("app")
  ])
).check(
  Schema.makeFilter((facts) =>
    new Set(facts.map((each) => each.fact)).size === facts.length
      ? undefined
      : "names a fact more than once"
  )
)

export const ToolDisplayWireSchema = Schema.Array(
  Schema.Struct({ fact: Schema.String, value: Schema.String })
)

const isKnownFact = (each: {
  readonly fact: string
  readonly value: string
}): each is ToolDisplayFact =>
  Object.entries(TOOL_DISPLAY_FACTS).some(
    ([fact, values]) => fact === each.fact && values.some((value: string) => value === each.value)
  )

export const toToolDisplay = (
  wire: Schema.Schema.Type<typeof ToolDisplayWireSchema>
): ToolDisplay => wire.filter(isKnownFact)

export const LEGACY_TOOL_DISPLAY: Readonly<Record<string, ToolDisplay>> = {
  email_send: [{ fact: "mail", value: "send" }],
  email_reply: [{ fact: "mail", value: "reply" }],
  email_forward: [{ fact: "mail", value: "forward" }],
  exec_command: [
    { fact: "card", value: "command" },
    { fact: "refresh", value: "terminals" }
  ],
  bash: [
    { fact: "card", value: "command" },
    { fact: "refresh", value: "terminals" }
  ],
  file_write: [
    { fact: "card", value: "file_change" },
    { fact: "result", value: "applied_edit" }
  ],
  file_edit: [
    { fact: "card", value: "file_change" },
    { fact: "result", value: "applied_edit" }
  ],
  automation_create: [
    { fact: "card", value: "automation" },
    { fact: "result", value: "automation_created" },
    { fact: "refresh", value: "automations" }
  ],
  automation_update: [{ fact: "refresh", value: "automations" }],
  automation_delete: [{ fact: "refresh", value: "automations" }],
  automation_run: [{ fact: "refresh", value: "automations" }],
  automation_blocked: [{ fact: "row", value: "blocked" }],
  browser_permission: [{ fact: "card", value: "site_grant" }],
  browser_ask_secret: [{ fact: "card", value: "site_secret" }],
  wiki_patch_page: [{ fact: "card", value: "page_patch" }],
  code_mode: [{ fact: "row", value: "code" }],
  todo_update: [{ fact: "trail", value: "plan" }],
  no_reply: [{ fact: "trail", value: "hidden" }],
  artifact_save: [{ fact: "result", value: "saved_artifact" }],
  session_send_message: [{ fact: "result", value: "chat_sent" }],
  tool_search: [{ fact: "result", value: "tool_list" }],
  load_tools: [{ fact: "result", value: "tool_list" }],
  session_read: [{ fact: "row", value: "chat_read" }],
  web_search: [{ fact: "row", value: "web_sites" }],
  skill: [{ fact: "row", value: "skill" }],
  report: [{ fact: "row", value: "report" }],
  show_tour: [{ fact: "app", value: "tour" }]
}
