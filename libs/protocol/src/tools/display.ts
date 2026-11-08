import { Schema } from "effect"
import { withExtras } from "../common/schema.js"
import type { JsonRecord } from "../common/json.js"

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
   *  patch, a site's standing grant, a sign-in secret, a Memory page patch
   *  read as words, or a new automation's editable fields. */
  card: [
    "command",
    "file_change",
    "site_grant",
    "site_secret",
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

/** One tool's display facts. A fact left out is the generic row and card. */
export type ToolDisplay = JsonRecord & {
  readonly [Fact in keyof Facts]?: Facts[Fact][number]
}

const exact = <const Values extends ReadonlyArray<string>>(values: Values) =>
  Schema.optionalKey(Schema.Literals(values))

/** The facts as a tool declares them in its server metadata: exact values. */
export const ToolDisplaySchema = Schema.Struct({
  mail: exact(TOOL_DISPLAY_FACTS.mail),
  card: exact(TOOL_DISPLAY_FACTS.card),
  result: exact(TOOL_DISPLAY_FACTS.result),
  refresh: exact(TOOL_DISPLAY_FACTS.refresh),
  row: exact(TOOL_DISPLAY_FACTS.row),
  trail: exact(TOOL_DISPLAY_FACTS.trail),
  app: exact(TOOL_DISPLAY_FACTS.app)
})

const anyText = Schema.optionalKey(Schema.String)

/**
 * The facts on the wire. Read leniently: a value or fact this client does not
 * know (a newer server's) is dropped, so it draws the generic row instead of
 * refusing the whole catalog.
 */
export const ToolDisplayWireSchema = withExtras({
  mail: anyText,
  card: anyText,
  result: anyText,
  refresh: anyText,
  row: anyText,
  trail: anyText,
  app: anyText
})

const known = <const Values extends ReadonlyArray<string>>(
  values: Values,
  value: string | undefined
): Values[number] | undefined => values.find((each) => each === value)

export const toToolDisplay = (
  wire: Schema.Schema.Type<typeof ToolDisplayWireSchema>
): ToolDisplay => {
  const mail = known(TOOL_DISPLAY_FACTS.mail, wire.mail)
  const card = known(TOOL_DISPLAY_FACTS.card, wire.card)
  const result = known(TOOL_DISPLAY_FACTS.result, wire.result)
  const refresh = known(TOOL_DISPLAY_FACTS.refresh, wire.refresh)
  const row = known(TOOL_DISPLAY_FACTS.row, wire.row)
  const trail = known(TOOL_DISPLAY_FACTS.trail, wire.trail)
  const app = known(TOOL_DISPLAY_FACTS.app, wire.app)
  return {
    ...(mail === undefined ? {} : { mail }),
    ...(card === undefined ? {} : { card }),
    ...(result === undefined ? {} : { result }),
    ...(refresh === undefined ? {} : { refresh }),
    ...(row === undefined ? {} : { row }),
    ...(trail === undefined ? {} : { trail }),
    ...(app === undefined ? {} : { app })
  }
}

/**
 * The facts a server that predates `display` held for its tools, frozen as
 * they were. Only the catalog decoder reads it, for such a server's catalog,
 * and the desktop until its first catalog arrives. Never add to it: a new
 * fact or tool is declared on the tool.
 */
export const LEGACY_TOOL_DISPLAY: Readonly<Record<string, ToolDisplay>> = {
  email_send: { mail: "send" },
  email_reply: { mail: "reply" },
  email_forward: { mail: "forward" },
  exec_command: { card: "command", refresh: "terminals" },
  bash: { card: "command", refresh: "terminals" },
  file_write: { card: "file_change", result: "applied_edit" },
  file_edit: { card: "file_change", result: "applied_edit" },
  automation_create: {
    card: "automation",
    result: "automation_created",
    refresh: "automations"
  },
  automation_update: { refresh: "automations" },
  automation_delete: { refresh: "automations" },
  automation_run: { refresh: "automations" },
  automation_blocked: { row: "blocked" },
  browser_permission: { card: "site_grant" },
  browser_ask_secret: { card: "site_secret" },
  wiki_patch_page: { card: "page_patch" },
  code_mode: { row: "code" },
  todo_update: { trail: "plan" },
  no_reply: { trail: "hidden" },
  artifact_save: { result: "saved_artifact" },
  session_send_message: { result: "chat_sent" },
  tool_search: { result: "tool_list" },
  load_tools: { result: "tool_list" },
  session_read: { row: "chat_read" },
  web_search: { row: "web_sites" },
  skill: { row: "skill" },
  report: { row: "report" },
  show_tour: { app: "tour" }
}
