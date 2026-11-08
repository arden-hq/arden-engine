import { isJsonObject, jsonText } from "../json.js"
import type { ProcedureEvidence, ProcedureEvidenceCall } from "./model.js"

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{12,}|[A-Za-z0-9_-]{24,})$/iu
const PLACEHOLDER_SEGMENT = /\{[a-z0-9_]+\}/u
const PAGE_ORIGIN = /^origin: (\S+)$/mu

const decodedSegment = (part: string): string => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

export const maskPathIds = (path: string): string =>
  path
    .split("/")
    .map(decodedSegment)
    .map((part) => (ID_SEGMENT.test(part) ? ":id" : part))
    .join("/")

export const pathTemplate = (url: URL): string => maskPathIds(url.pathname)

export const pathMatches = (template: string, href: string): boolean => {
  if (!URL.canParse(href)) return false
  const want = template.split("/")
  const have = pathTemplate(new URL(href)).split("/")
  return (
    want.length === have.length &&
    want.every(
      (part, index) => part === have[index] || part === ":id" || PLACEHOLDER_SEGMENT.test(part)
    )
  )
}

export const shownPage = (call: ProcedureEvidenceCall): URL | undefined => {
  const data = call.result["data"]
  const tab = isJsonObject(data) && isJsonObject(data["tab"]) ? data["tab"] : {}
  const href = PAGE_ORIGIN.exec(jsonText(call.result["content"]))?.[1] ?? jsonText(tab["url"])
  return URL.canParse(href) ? new URL(href) : undefined
}

const TARGET_LABEL = /^([A-Za-z]+) "((?:[^"\\]|\\.)*)"$/u

export interface ProcedureStart {
  readonly path: string
  readonly controls: ReadonlyArray<{ readonly role: string; readonly name: string }>
}

export const procedureStart = (
  evidence: ProcedureEvidence | undefined
): ProcedureStart | undefined => {
  const calls = evidence?.calls ?? []
  const first = calls.map(shownPage).find((page) => page !== undefined)
  if (first === undefined) return undefined
  const path = pathTemplate(first)
  const controls: Array<{ readonly role: string; readonly name: string }> = []
  for (const call of calls) {
    if (call.name === "browser_act") {
      const label = TARGET_LABEL.exec(jsonText(call.args["target_label"]))
      if (label?.[1] !== undefined && label[2] !== undefined && !PLACEHOLDER_SEGMENT.test(label[2]))
        controls.push({ role: label[1], name: label[2].replaceAll('\\"', '"') })
    }
    const page = shownPage(call)
    if (page !== undefined && call.name !== "browser_open" && pathTemplate(page) !== path) break
  }
  const unique = new Map(controls.map((control) => [`${control.role} ${control.name}`, control]))
  return { path, controls: [...unique.values()] }
}
