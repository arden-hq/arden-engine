import { Schema } from "effect"

import { isJsonObject, jsonText, type JsonObject } from "../json.js"
import {
  PAGE_TEXT_MAX_CHARS,
  type ProcedureEvidenceCall,
  type ProcedureEvidenceCondensed
} from "./model.js"
import { FIELD_ROLES, redactEvidenceCalls } from "./redact.js"
import { parseSnapshotNode, type SnapshotNode } from "./snapshot-line.js"
import { pathTemplate, shownPage } from "./start.js"

type Json = Schema.Json

const EVIDENCE_MAX_CHARS = 96_000
const EVIDENCE_MAX_CALLS = 120

export interface BrowserRunCall {
  readonly id: string
  readonly name: string
  readonly args: JsonObject
  readonly content: string
  readonly data: JsonObject
  readonly isError: boolean
  readonly changesState: boolean
  readonly pageChecked: boolean
}
export interface CondensedBrowserRun {
  readonly calls: ReadonlyArray<ProcedureEvidenceCall>
  readonly condensed: ProcedureEvidenceCondensed
}

const ACTIONS = new Set(["browser_act", "browser_open"])
const PAGE_START = "--- PAGE CONTENT"
const PAGE_END = "--- END PAGE CONTENT"
const STRUCTURE_ROLES = new Set([
  "heading",
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "listbox",
  "option",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "tablist",
  "tabpanel",
  "dialog",
  "alertdialog",
  "form",
  "search",
  "navigation",
  "group",
  "LabelText"
])
const URL_LINE = /^\s*- \/url: /u
const TOOL_LINES = [
  "Opened ",
  "Tab: ",
  "Profile: ",
  "Origin: ",
  "origin: ",
  "Page:",
  "Page after the action:",
  "No browser tabs are open.",
  "Verification required",
  "The page could not be read"
]
const PAGE_BUDGETS = [8_000, 4_000, 2_000, 1_000, 0]
const LAST_PAGE_FLOOR = 2_000

const ECHO_SEGMENT = /\\n|\n|\r/u
const ECHO_KEY = /^(?:"[\p{L}_-]{1,40}"\s*:\s*"?|\p{L}[\p{L}_-]*:\s*)$/u
const echoOf = (
  line: string,
  node: SnapshotNode | undefined,
  placeholders: ReadonlySet<string>
): string | undefined => {
  if (node === undefined) return undefined
  const kept = line
    .slice(node.indent.length + node.role.length)
    .replace(/^ "/u, "")
    .replaceAll('\\"', '"')
    .split(ECHO_SEGMENT)
    .flatMap((segment) =>
      [...placeholders].flatMap((placeholder) => {
        const at = segment.indexOf(placeholder)
        const key = at < 0 ? undefined : ECHO_KEY.exec(segment.slice(0, at).trimStart())?.[0]
        return key === undefined
          ? []
          : [`${key.trim()}${key.endsWith('"') ? "" : " "}${placeholder}`]
      })
    )
  return kept.length === 0 ? undefined : `${node.indent}${node.role}: ${kept.join(" … ")}`
}

const structureOnly = (content: string, placeholders: ReadonlySet<string>): string => {
  let inPage = false
  const kept: Array<string> = []
  for (const line of content.split("\n")) {
    if (line.startsWith(PAGE_START)) inPage = true
    const marker = line.startsWith(PAGE_START) || line.startsWith(PAGE_END)
    const node = parseSnapshotNode(line)
    const keep = inPage
      ? marker ||
        line.startsWith("origin: ") ||
        URL_LINE.test(line) ||
        STRUCTURE_ROLES.has(node?.role ?? "")
      : TOOL_LINES.some((start) => line.startsWith(start))
    const echo = inPage && !keep ? echoOf(line, node, placeholders) : undefined
    if (echo !== undefined) kept.push(echo)
    else if (keep)
      kept.push(
        node === undefined || FIELD_ROLES.has(node.role) ? line : line.slice(0, node.headLength)
      )
    if (line.startsWith(PAGE_END)) inPage = false
  }
  return kept.join("\n")
}

const splitPage = (content: string): { readonly head: string; readonly page: string } => {
  const start = content.indexOf(PAGE_START)
  if (start < 0) return { head: content, page: "" }
  return { head: content.slice(0, start), page: content.slice(start) }
}
const cutLines = (text: string, budget: number): string => {
  if (text.length <= budget) return text
  const cut = text.lastIndexOf("\n", budget)
  return cut < 0 ? "" : text.slice(0, cut)
}
const withPage = (content: string, budget: number): string => {
  const { head, page } = splitPage(content)
  if (page.length <= budget) return content
  const kept = cutLines(page, budget)
  return `${head}${kept}${kept === "" ? "" : "\n"}[page: ${page.length - kept.length} chars not kept]`
}

const structureData = (data: JsonObject): JsonObject => {
  const tab = isJsonObject(data["tab"]) ? data["tab"] : undefined
  const change = isJsonObject(data["change_evidence"]) ? data["change_evidence"] : undefined
  const picked: Record<string, Json> = {}
  for (const key of ["origin", "snapshot_ref", "procedure_learning"])
    if (data[key] !== undefined) picked[key] = data[key]
  if (tab !== undefined)
    picked["tab"] = Object.fromEntries(
      ["url", "profile_ref", "tab_ref"].flatMap((key) =>
        tab[key] === undefined ? [] : [[key, tab[key]]]
      )
    )
  if (change?.["call_outcome"] !== undefined)
    picked["change_evidence"] = { call_outcome: change["call_outcome"] }
  return picked
}

const visitKey = (call: ProcedureEvidenceCall): string | undefined => {
  const data = call.result["data"]
  const tab = isJsonObject(data) && isJsonObject(data["tab"]) ? data["tab"] : {}
  const page = shownPage(call)
  if (page === undefined) return undefined
  const tabRef = jsonText(tab["tab_ref"]) || jsonText(call.args["tab_ref"])
  return `${tabRef} ${page.origin}${pathTemplate(page)}`
}

interface Visit {
  readonly key: string
  readonly calls: Array<number>
}
const buildVisits = (calls: ReadonlyArray<ProcedureEvidenceCall>): ReadonlyArray<Visit> => {
  const visits: Array<Visit> = []
  calls.forEach((call, index) => {
    const key = visitKey(call) ?? visits.at(-1)?.key ?? ""
    const current = visits.at(-1)
    if (current !== undefined && current.key === key && call.name !== "browser_open")
      current.calls.push(index)
    else visits.push({ key, calls: [index] })
  })
  return visits
}

const hasPageText = (call: ProcedureEvidenceCall): boolean => {
  const { page } = splitPage(jsonText(call.result["content"]))
  return page !== "" && !page.startsWith("[page:")
}
const sizeOf = (calls: ReadonlyArray<ProcedureEvidenceCall>): number => JSON.stringify(calls).length

export const condenseBrowserRun = (
  run: ReadonlyArray<BrowserRunCall>,
  maxChars: number = EVIDENCE_MAX_CHARS
): CondensedBrowserRun => {
  const { calls: redacted, placeholders } = redactEvidenceCalls(
    run.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
      result: {
        content: call.content,
        data: structureData(call.data),
        is_error: call.isError
      },
      changes_state: call.changesState
    }))
  )
  const structured = redacted.map((call, index) => ({
    ...call,
    result: {
      ...call.result,
      content: cutLines(
        structureOnly(
          run[index]?.pageChecked === false
            ? withPage(jsonText(call.result["content"]), 0)
            : jsonText(call.result["content"]),
          placeholders
        ),
        PAGE_TEXT_MAX_CHARS
      )
    }
  }))
  const visits = buildVisits(structured)
  const isAction = (index: number) => ACTIONS.has(structured[index]?.name ?? "")
  const hasPage = (index: number) =>
    splitPage(jsonText(structured[index]?.result["content"])).page !== ""
  const keptPage = new Set(
    visits.flatMap((visit) => {
      const last = visit.calls.findLast(hasPage)
      return last === undefined ? [] : [last]
    })
  )
  const lastVisit = visits.at(-1)
  const finalPage = lastVisit?.calls.findLast(hasPage)
  const quiet = new Set(
    visits
      .filter((visit) => visit !== visits[0] && visit !== lastVisit && !visit.calls.some(isAction))
      .flatMap((visit) => visit.calls)
  )
  const reads = structured.filter((call) => !ACTIONS.has(call.name)).length
  const pageBudget = (index: number, budget: number): number => {
    if (!keptPage.has(index)) return 0
    return index === finalPage ? Math.max(budget, LAST_PAGE_FLOOR) : budget
  }
  const shaped = (budget: number, dropQuiet: boolean): Array<ProcedureEvidenceCall> =>
    structured.flatMap((call, index) => {
      if (dropQuiet && quiet.has(index) && !isAction(index)) return []
      const content = withPage(jsonText(call.result["content"]), pageBudget(index, budget))
      return [{ ...call, result: { ...call.result, content } }]
    })

  let calls = shaped(PAGE_TEXT_FULL, false)
  for (const [step, budget] of PAGE_BUDGETS.entries()) {
    if (fits(calls, maxChars)) break
    calls = shaped(budget, step >= 1)
  }
  const finalCall = finalPage === undefined ? undefined : structured[finalPage]?.id
  if (!fits(calls, maxChars))
    calls = calls.filter((call) => ACTIONS.has(call.name) || hasPageText(call))
  if (!fits(calls, maxChars))
    calls = calls.filter((call) => ACTIONS.has(call.name) || call.id === finalCall)
  const fitted = fits(calls, maxChars) ? { calls, omitted: 0 } : headAndTail(calls, maxChars)
  return {
    calls: fitted.calls,
    condensed: {
      visits: visits.length,
      actions: structured.filter((call) => ACTIONS.has(call.name)).length,
      reads,
      reads_kept: fitted.calls.filter(
        (call) => !ACTIONS.has(call.name) && call.name !== OMITTED && hasPageText(call)
      ).length,
      steps_omitted: fitted.omitted
    }
  }
}

const PAGE_TEXT_FULL = Number.MAX_SAFE_INTEGER
const OMITTED = "steps_omitted"
const fits = (calls: ReadonlyArray<ProcedureEvidenceCall>, maxChars: number): boolean =>
  calls.length <= EVIDENCE_MAX_CALLS && sizeOf(calls) <= maxChars

const headAndTail = (
  calls: ReadonlyArray<ProcedureEvidenceCall>,
  maxChars: number
): { readonly calls: ReadonlyArray<ProcedureEvidenceCall>; readonly omitted: number } => {
  const marker = (omitted: number): ProcedureEvidenceCall => ({
    id: OMITTED,
    name: OMITTED,
    args: {},
    result: { content: `${omitted} steps omitted`, data: {}, is_error: false },
    changes_state: false
  })
  const sizes = calls.map((call) => JSON.stringify(call).length + 1)
  let used = sizeOf([marker(calls.length)]) + 1
  let head = 0
  let tail = 0
  for (let turn = 0; head + tail < calls.length; turn++) {
    const fromEnd = turn % 2 === 0
    const index = fromEnd ? calls.length - 1 - tail : head
    const size = sizes[index] ?? 0
    if (used + size > maxChars || head + tail + 2 > EVIDENCE_MAX_CALLS) break
    used += size
    if (fromEnd) tail++
    else head++
  }
  const omitted = calls.length - head - tail
  return {
    calls: [...calls.slice(0, head), marker(omitted), ...calls.slice(calls.length - tail)],
    omitted
  }
}
