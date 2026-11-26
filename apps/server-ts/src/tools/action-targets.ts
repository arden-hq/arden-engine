import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { clipLine } from "@arden-hq/std/text"
import { listWords, quoted } from "@arden-hq/std/count"
import { isWithin } from "@arden-hq/std/paths"
import path from "node:path"
import { CHANGE_ENTRY_PLACE_MAX, CHANGE_ENTRY_TITLE_MAX } from "@arden-hq/protocol/effect/chat"

import {
  BROWSER_ACT_ACTION,
  BROWSER_OPERATION,
  BROWSER_POINTER_ACTION,
  SITE_PERMISSION_ANSWER,
  type BrowserRequest
} from "../browser/service.js"
import type { EffectTarget } from "../execution/tool-effect.js"
import { bundleName } from "../computer/bundle-id.js"

const FOLDER_MAX = 80

const folderWords = (cwd: string, home: string): string => {
  const short = isWithin(home, cwd) ? path.join("~", path.relative(home, cwd)) : cwd
  return short.length <= FOLDER_MAX ? short : `…${short.slice(short.length - FOLDER_MAX + 1)}`
}

const LEADING_ASSIGNMENTS =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]+)*\s+)+/u

const HEREDOC = /(?:\s+-)?\s*(?<!<)<<(?!<)(-)?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u

const commandWords = (command: string): string => {
  const lines: string[] = []
  let delimiter: { readonly tag: string; readonly tabs: boolean } | undefined
  for (const line of command.split("\n")) {
    if (delimiter !== undefined) {
      const end = delimiter.tabs ? line.replace(/^\t+/u, "") : line
      if (end.trimEnd() === delimiter.tag) delimiter = undefined
      continue
    }
    const heredoc = HEREDOC.exec(line)
    if (heredoc === null) {
      lines.push(line)
      continue
    }
    delimiter = { tag: heredoc[2] ?? "", tabs: heredoc[1] !== undefined }
    lines.push(line.replace(HEREDOC, " script"))
  }
  const words = lines.join(" ").trim()
  const bare = words.replace(LEADING_ASSIGNMENTS, "")
  return bare === "" ? words : bare
}

export const commandTarget = (input: {
  readonly toolCallId: string
  readonly command: string
  readonly cwd: string
  readonly home: string
}): EffectTarget => {
  const folder = ` (in ${folderWords(input.cwd, input.home)})`
  return {
    source: "command",
    objectId: input.toolCallId,
    title: `${clipLine(commandWords(input.command), CHANGE_ENTRY_TITLE_MAX - folder.length)}${folder}`,
    place: folderWords(input.cwd, input.home)
  }
}

type BrowserOperation = BrowserRequest["operation"]

export interface BrowserElement {
  readonly role: string
  readonly name: string
}

export const hostOf = (url: string): string | undefined => {
  if (!URL.canParse(url)) return undefined
  const host = new URL(url).host
  return host === "" ? undefined : host
}

const withoutQuery = (url: string): string => url.replace(/[?#].*$/su, "")

const pageWords = (url: string): string => {
  if (!URL.canParse(url)) return clipLine(withoutQuery(url), 200)
  const page = new URL(url)
  if (page.host === "") return clipLine(withoutQuery(url), 200)
  return clipLine(`${page.host}${page.pathname.replace(/^\/$/u, "")}`, 200)
}

export const pageLink = (url: string): string | undefined => {
  if (!/^https?:\/\//iu.test(url) || !URL.canParse(url)) return undefined
  const page = new URL(url)
  return `${page.origin}${page.pathname}`
}

const elementWords = (element: BrowserElement | undefined, fallback: string): string => {
  if (element === undefined) return fallback
  if (element.name.trim() !== "") return quoted(element.name, 80)
  return element.role.trim() === "" ? fallback : `a ${clipLine(element.role, 40)}`
}

const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Space",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "ControlOrMeta"
])

const isKey = (key: string): boolean =>
  key.length === 1 || /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key) || NAMED_KEYS.has(key)

const keyWords = (value: string | undefined): string =>
  value !== undefined && value.split("+").every(isKey) ? value : "a key"

const actWords = (
  operation: Extract<BrowserOperation, { readonly type: typeof BROWSER_OPERATION.act }>,
  element: BrowserElement | undefined
): string => {
  const what = elementWords(element, "an element")
  switch (operation.action) {
    case BROWSER_ACT_ACTION.click:
      return `Clicked ${what}`
    case BROWSER_ACT_ACTION.dblclick:
      return `Double-clicked ${what}`
    case BROWSER_ACT_ACTION.hover:
      return `Pointed at ${what}`
    case BROWSER_ACT_ACTION.focus:
      return `Focused ${what}`
    case BROWSER_ACT_ACTION.fill:
    case BROWSER_ACT_ACTION.type:
      return `Typed in ${element === undefined || element.name.trim() === "" ? "a field" : quoted(element.name, 80)}`
    case BROWSER_ACT_ACTION.select:
      return `Chose an option in ${elementWords(element, "a list")}`
    case BROWSER_ACT_ACTION.check:
      return `Ticked ${what}`
    case BROWSER_ACT_ACTION.uncheck:
      return `Unticked ${what}`
    case BROWSER_ACT_ACTION.press:
      return `Pressed ${keyWords(operation.value)}`
    case BROWSER_ACT_ACTION.scroll:
      return `Scrolled ${operation.direction ?? "down"}`
  }
}

const permissionLine = (
  operation: Extract<BrowserOperation, { readonly type: typeof BROWSER_OPERATION.permission }>
): string => {
  const what = listWords(operation.permissions)
  switch (operation.answer) {
    case SITE_PERMISSION_ANSWER.once:
      return `${DECISION_WORD.allowed} ${what} once`
    case SITE_PERMISSION_ANSWER.always:
      return `${DECISION_WORD.allowed} ${what}`
    case SITE_PERMISSION_ANSWER.deny:
      return `${DECISION_WORD.denied} ${what}`
  }
}

const fileName = (file: string): string => file.slice(file.lastIndexOf("/") + 1)

const onSite = (origin: string): string => {
  const host = hostOf(origin)
  return host === undefined ? "" : ` on ${host}`
}

export const browserTarget = (
  operation: BrowserOperation,
  element?: BrowserElement
): EffectTarget | undefined => {
  const words = browserWords(operation, element)
  if (words === undefined) return undefined
  const link = operation.type === BROWSER_OPERATION.open ? pageLink(operation.url) : undefined
  const host = browserHost(operation)
  const tab =
    operation.type === BROWSER_OPERATION.open && operation.tabRef === undefined
      ? `site:${hostOf(operation.url) ?? withoutQuery(operation.url).slice(0, 200)}`
      : `tab:${"tabRef" in operation ? operation.tabRef : ""}`
  return {
    source: "browser",
    objectId: tab,
    title: clipLine(words, CHANGE_ENTRY_TITLE_MAX),
    ...(host === undefined ? {} : { place: host }),
    ...(link === undefined ? {} : { href: link })
  }
}

const browserHost = (operation: BrowserOperation): string | undefined => {
  switch (operation.type) {
    case BROWSER_OPERATION.open:
      return hostOf(operation.url)
    case BROWSER_OPERATION.act:
    case BROWSER_OPERATION.pointer:
    case BROWSER_OPERATION.upload:
    case BROWSER_OPERATION.permission:
      return hostOf(operation.origin)
    case BROWSER_OPERATION.close:
    case BROWSER_OPERATION.tabs:
    case BROWSER_OPERATION.snapshot:
    case BROWSER_OPERATION.screenshot:
    case BROWSER_OPERATION.target:
    case BROWSER_OPERATION.wait:
    case BROWSER_OPERATION.site_secrets:
    case BROWSER_OPERATION.card_frame:
    case BROWSER_OPERATION.card_checkout:
      return undefined
  }
}

const browserWords = (
  operation: BrowserOperation,
  element: BrowserElement | undefined
): string | undefined => {
  switch (operation.type) {
    case BROWSER_OPERATION.open:
      return `Opened ${pageWords(operation.url)}`
    case BROWSER_OPERATION.close:
      return "Closed tab"
    case BROWSER_OPERATION.act:
      return `${actWords(operation, element)}${onSite(operation.origin)}`
    case BROWSER_OPERATION.pointer:
      return `${operation.action === BROWSER_POINTER_ACTION.click ? "Clicked" : "Dragged"}${onSite(operation.origin)}`
    case BROWSER_OPERATION.upload: {
      const [only] = operation.files
      const what =
        operation.files.length === 1 && only !== undefined
          ? clipLine(fileName(only), 80)
          : `${operation.files.length} files`
      const host = hostOf(operation.origin)
      return `Uploaded ${what}${host === undefined ? "" : ` to ${host}`}`
    }
    case BROWSER_OPERATION.permission:
      return `${permissionLine(operation)}${onSite(operation.origin)}`
    case BROWSER_OPERATION.tabs:
    case BROWSER_OPERATION.snapshot:
    case BROWSER_OPERATION.screenshot:
    case BROWSER_OPERATION.target:
    case BROWSER_OPERATION.wait:
    case BROWSER_OPERATION.site_secrets:
    case BROWSER_OPERATION.card_frame:
    case BROWSER_OPERATION.card_checkout:
      return undefined
  }
}

export const appTarget = (input: {
  readonly objectId: string
  readonly title: string
  readonly place?: string
}): { place?: string; source: string; objectId: string; title: string } =>
  ({
    source: "app",
    objectId: input.objectId,
    title: clipLine(input.title, CHANGE_ENTRY_TITLE_MAX),
    ...(input.place === undefined ? {} : { place: clipLine(input.place, CHANGE_ENTRY_PLACE_MAX) })
  }) satisfies EffectTarget

export const launchedAppTarget = (bundleId: string): EffectTarget =>
  appTarget({
    objectId: bundleId,
    title: `Launched ${bundleName(bundleId)}`,
    place: bundleName(bundleId)
  })
