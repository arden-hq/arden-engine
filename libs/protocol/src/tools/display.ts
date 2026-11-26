import { Schema } from "effect"

/**
 * Each fact the desktop branches on to show a tool's calls, as a closed set of
 * values. A tool declares its facts once, in its server metadata (`display`);
 * the desktop reads them from the tool catalog and never compares tool names.
 */
export const TOOL_DISPLAY_FACTS = {
  /** A Gmail message the call writes: its card is the mail panel, its result
   *  may carry a send receipt or a saved draft, and the draft's account comes
   *  from `account_ref` ("send") or the replied-to `message_ref` ("reply"). */
  mail: ["send", "reply", "forward", "draft"],
  /** The approval card's own shape: a shell command, a file write with its
   *  patch, a site's standing grant, a sign-in secret, a saved key's use or a
   *  missing key's ask, a payment with a saved card or a card for a payment
   *  frame Arden does not know, a Memory page patch read as words, or a new
   *  automation's editable fields. */
  card: [
    "command",
    "file_change",
    "site_grant",
    "site_secret",
    "vault_key_use",
    "vault_key_ask",
    "vault_card_pay",
    "vault_card_frame",
    "page_patch",
    "automation",
    "calendar"
  ],
  /** What its result carries beside its row: an applied file edit, the
   *  automation it created, the artifact file it saved, the chat a message
   *  went to, or a list of tool ids said as names. */
  result: ["applied_edit", "automation_created", "saved_artifact", "chat_sent", "tool_list"],
  /** What else a live result changes, read again after it: the Automation
   *  list, or the commands left running in the chat. */
  refresh: ["automations", "terminals"],
  /** How its row reads: a script's card, a web search's sites, the chat a
   *  read names, the Skill it loads, a report that may say it is blocked, or
   *  a blocker report of its own. */
  row: ["code", "web_sites", "chat_read", "skill", "report", "blocked"],
  /** Kept out of the trail: drawn nowhere, or as the Plan card. */
  trail: ["hidden", "plan"],
  /** What the desktop app itself does once the call completes: start the tour. */
  app: ["tour"]
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

const APP_ONLY_CARDS = [
  "site_secret",
  "vault_key_ask",
  "vault_card_pay",
  "vault_card_frame"
] as const satisfies ReadonlyArray<Facts["card"][number]>

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

/**
 * The facts a server that predates `display` held for its tools, frozen as
 * they were. Only the catalog decoder reads it, for such a server's catalog,
 * and the desktop until its first catalog arrives. Never add to it: a new
 * fact or tool is declared on the tool.
 */
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
