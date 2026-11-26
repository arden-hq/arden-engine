import { ToolExecutionError } from "@arden-hq/loop"
import { ERRNO, isErrnoCode } from "@arden-hq/std/errors"
import { PLATFORM } from "@arden-hq/std/process"
import { Option, Schema } from "effect"
import { execFile } from "node:child_process"

import type { CallEffects } from "../execution/tool-effect.js"
import { toolRefusal } from "./tool-failure.js"

const HELPER_TIMEOUT_MS = 150_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export const MAC_APPS_SOURCE = "_mac_apps"
export const MAC_APPS_WRITE_GROUP = "mac_apps_write"

export interface MacAppsHelperOptions {
  readonly path?: string | undefined
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
}

export interface MacAppsHelper {
  readonly run: (
    args: ReadonlyArray<string>,
    options: { readonly signal: AbortSignal; readonly effects?: CallEffects }
  ) => Promise<unknown>
}

export const makeMacAppsHelper = ({
  path = process.env["ARDEN_APPLE_APPS_HELPER"],
  platform = process.platform,
  timeoutMs = HELPER_TIMEOUT_MS
}: MacAppsHelperOptions = {}): MacAppsHelper => ({
  run: async (args, { signal, effects }) => {
    if (platform !== PLATFORM.darwin || path === undefined || path === "") throw unavailable()
    signal.throwIfAborted()
    effects?.sent()
    const outcome = await execute(path, args, signal, timeoutMs)
    if (outcome.kind === HELPER_OUTCOME.printed) {
      const value = parseJson(outcome.stdout)
      if (Option.isNone(value)) throw unreadable(effects !== undefined)
      effects?.applied()
      return value.value
    }
    signal.throwIfAborted()
    if (outcome.kind === HELPER_OUTCOME.missing) {
      effects?.failed()
      throw unavailable()
    }
    if (outcome.kind === HELPER_OUTCOME.timed_out) {
      throw toolRefusal(
        `The Mac did not answer in ${Math.round(timeoutMs / 1_000)} seconds; macOS may be waiting for the owner to allow access.${effects === undefined ? "" : " The change may or may not have been made: read the item before you try again."}`,
        "No answer from the Mac"
      )
    }
    const fault = Option.flatMap(parseJson(lastLine(outcome.stderr)), decodeFault)
    if (Option.isNone(fault)) throw unreadable(effects !== undefined)
    effects?.failed()
    throw toolRefusal(
      toolWords(fault.value.message),
      (Object.hasOwn(FAULT_PREVIEWS, fault.value.error)
        ? FAULT_PREVIEWS[fault.value.error]
        : undefined) ?? "Mac app request failed"
    )
  }
})

const HELPER_OUTCOME = {
  printed: "printed",
  faulted: "faulted",
  missing: "missing",
  timed_out: "timed_out"
} as const

type Outcome =
  | { readonly kind: typeof HELPER_OUTCOME.printed; readonly stdout: string }
  | { readonly kind: typeof HELPER_OUTCOME.faulted; readonly stderr: string }
  | { readonly kind: typeof HELPER_OUTCOME.missing }
  | { readonly kind: typeof HELPER_OUTCOME.timed_out }

const execute = (
  path: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Outcome> =>
  new Promise((resolve) => {
    execFile(
      path,
      [...args],
      { signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ kind: "printed", stdout })
        if (isErrnoCode(error, ERRNO.ENOENT) || isErrnoCode(error, ERRNO.EACCES))
          return resolve({ kind: "missing" })
        if (error.killed === true && !signal.aborted) return resolve({ kind: "timed_out" })
        resolve({ kind: "faulted", stderr })
      }
    )
  })

const FaultSchema = Schema.Struct({ error: Schema.String, message: Schema.String })
const decodeFault = Schema.decodeUnknownOption(FaultSchema)

const FAULT_PREVIEWS: Readonly<Record<string, string>> = {
  not_asked: "macOS did not ask for access",
  denied: "Access is off",
  restricted: "Access is blocked on this Mac",
  write_only: "Calendar access is add-only",
  not_found: "Not found",
  read_only: "Read-only",
  usage: "Invalid request",
  failed: "Not saved"
}

const unavailable = (): ToolExecutionError =>
  toolRefusal(
    "The Calendar, Reminders and Contacts apps are reachable only through the Arden desktop app on a Mac, and they are not reachable here. Say so; do not try another way. For a connected Google account use the calendar_* tools.",
    "Mac apps are not available here"
  )

const unreadable = (change: boolean): ToolExecutionError =>
  toolRefusal(
    `The Mac's answer could not be read.${change ? " The change may or may not have been made: read the item before you try again." : ""}`,
    "Unreadable answer from the Mac"
  )

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const lastLine = (text: string): string => text.trimEnd().split("\n").at(-1) ?? ""

const COMMAND_TOOLS: Readonly<Record<string, string>> = {
  "calendar list": "mac_calendar_list_calendars",
  "calendar events": "mac_calendar_search",
  "reminders lists": "mac_reminders_list_lists",
  "reminders list": "mac_reminders_search",
  "contacts search": "mac_contacts_search"
}
const OPTION_PARAMETERS: Readonly<Record<string, string>> = {
  calendar: "calendar_id",
  list: "list_id",
  "all-day": "all_day",
  "due-before": "due_before",
  alert: "alert_minutes",
  span: "scope",
  undo: "reopen"
}

const toolWords = (message: string): string =>
  message
    .replace(/`arden-apple ([a-z]+ [a-z]+)`/gu, (whole, command: string) =>
      Object.hasOwn(COMMAND_TOOLS, command) ? (COMMAND_TOOLS[command] ?? whole) : whole
    )
    .replace(/--([a-z]+(?:-[a-z]+)*)/gu, (_, option: string) =>
      Object.hasOwn(OPTION_PARAMETERS, option) ? (OPTION_PARAMETERS[option] ?? option) : option
    )

export const helperOption = (
  name: string,
  value: string | number | undefined
): ReadonlyArray<string> => (value === undefined ? [] : [`--${name}`, String(value)])

export const quotedLines = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/u).map((line) => `> ${line}`)
