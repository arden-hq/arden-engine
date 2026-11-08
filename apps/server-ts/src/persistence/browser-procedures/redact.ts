import { slugify, uniqueName } from "@arden-hq/std/slug"
import { escapeRegExp } from "@arden-hq/std/text"
import { Schema } from "effect"

import { isJsonObject, jsonText, type JsonObject } from "../json.js"
import type { ProcedureEvidenceCall } from "./model.js"
import { parseSnapshotNode } from "./snapshot-line.js"
import { maskPathIds } from "./start.js"

type Json = Schema.Json
type EvidenceCall = ProcedureEvidenceCall

export const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"])
const CHECKED = /(?<=[[\s,])checked(?:=(?:true|false|mixed))?(?=[,\]])/gu
const CHOICE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"])
const LINK_TARGET = /^(\s*- \/url: )(\S+)/gmu
const URL_PART = /(https?:\/\/[^\s"'<>`]+)/giu
const ORIGIN = /^https?:\/\/[^/?#]*/iu
const WORD = "[\\p{L}\\p{N}_]"
const MIN_ANYWHERE = 3
const LABEL_MAX = 80
const OPTIONS_MAX = 20
const STRUCTURE = new Set([
  "action",
  "kind",
  "condition",
  "origin",
  "profile_ref",
  "tab_ref",
  "snapshot_ref",
  "direction",
  "amount",
  "timeout_ms",
  "max_chars",
  "mode",
  "disposition",
  "depth",
  "exact",
  "procedure_learning"
])
const WAIT_DATA = new Set(["text", "url"])

const labelOf = (name: string): string =>
  slugify(name, { separator: "_", max: 40, trimCut: true, fallback: "value" })
const decodedKey = (key: string): string => {
  try {
    return decodeURIComponent(key.replaceAll("+", " "))
  } catch {
    return key
  }
}
const SENTINEL_EDGE = "\u0000"
const SENTINEL_BASE = 0xf0000
const unmatchableSentinel = (index: number) =>
  `${SENTINEL_EDGE}${String.fromCodePoint(SENTINEL_BASE + index)}${SENTINEL_EDGE}`
const bounded = (source: string) => new RegExp(`(?<!${WORD})(?:${source})(?!${WORD})`, "giu")

export interface RedactedEvidence {
  readonly calls: ReadonlyArray<EvidenceCall>
  readonly placeholders: ReadonlySet<string>
}

interface Variant {
  readonly pattern: RegExp
  readonly placeholder: string
  readonly weight: number
}

const sourcesOf = (value: string): ReadonlyArray<string> => {
  const encoded = encodeURIComponent(value)
  const digits = value.replace(/\D/gu, "")
  const phone = /^[\d\s().+-]+$/u.test(value) && digits.length >= 7
  const lines = value.includes("\n")
    ? value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_ANYWHERE)
    : []
  return [value, ...(encoded === value ? [] : [encoded, encoded.replaceAll("%20", "+")]), ...lines]
    .map(escapeRegExp)
    .concat(phone ? [`\\+?${[...digits].join("[\\s().-]*")}`] : [])
}

export const redactEvidenceCalls = (calls: ReadonlyArray<EvidenceCall>): RedactedEvidence => {
  const placeholders = new Map<string, string>()
  const fields = new Map<string, string>()
  const used = new Set<string>()
  const fresh = (name: string): string => {
    const label = uniqueName(labelOf(name), used, "_")
    used.add(label)
    return `{${label}}`
  }
  const placeholder = (value: string, name: string | undefined): string => {
    const key = value.trim()
    if (name !== undefined && !fields.has(key)) fields.set(key, name)
    const known = placeholders.get(key)
    if (known !== undefined) return known
    const next = fresh(name ?? "value")
    placeholders.set(key, next)
    return next
  }
  const typed = new Set<string>()
  const typedPlaceholder = (value: string, name: string | undefined): string => {
    const named = placeholder(value, name)
    typed.add(named)
    return named
  }
  const refs = new Map<string, { readonly role: string; readonly name: string }>()
  const choices = new Map<string, string>()
  const refOf = (target: JsonObject) => refs.get(jsonText(target["node_ref"]).replace(/^@/u, ""))
  const redactFields = (content: string): string =>
    content
      .split("\n")
      .map((line) => {
        const node = parseSnapshotNode(line)
        if (node === undefined || !FIELD_ROLES.has(node.role)) return line
        if (node.value === undefined || node.value === "") return line
        const label = node.name ?? (node.ref === undefined ? undefined : refs.get(node.ref)?.name)
        return `${line.slice(0, node.valueAt)}${placeholder(node.value, label)}`
      })
      .join("\n")
      .replace(CHECKED, "checked={checked}")
  const typedName = (target: JsonObject): string | undefined => {
    const named = jsonText(target["name"])
    if (named !== "") return named
    const kind = jsonText(target["kind"])
    if (kind === "label" || kind === "placeholder") return jsonText(target["value"]) || undefined
    return refOf(target)?.name
  }
  const redactAct = (given: JsonObject): JsonObject => {
    const target = isJsonObject(given["target"]) ? given["target"] : undefined
    const action = jsonText(given["action"])
    const choice =
      target !== undefined &&
      (action === "check" ||
        action === "uncheck" ||
        (action === "click" && CHOICE_ROLES.has(refOf(target)?.role ?? "")))
    if (choice) {
      const role = refOf(target)?.role
      const picked = fresh("choice")
      const label = refOf(target)?.name.trim() ?? ""
      if (label.length >= MIN_ANYWHERE && !choices.has(label)) choices.set(label, picked)
      const options = [...refs.values()]
        .filter((ref) => ref.role === role)
        .map((ref) => ref.name.trim().slice(0, LABEL_MAX))
      return {
        ...given,
        target: { node_ref: picked },
        target_label: role ?? "choice",
        ...(options.length === 0 ? {} : { options: [...new Set(options)].slice(0, OPTIONS_MAX) })
      }
    }
    const name = target === undefined ? undefined : typedName(target)
    const control = target === undefined ? undefined : refOf(target)
    const args =
      control === undefined
        ? given
        : { ...given, target_label: `${control.role} "${control.name.slice(0, LABEL_MAX)}"` }
    if ((action === "fill" || action === "type") && typeof args["value"] === "string")
      return { ...args, value: typedPlaceholder(args["value"], name) }
    const values = args["values"]
    if (action === "select" && Array.isArray(values))
      return {
        ...args,
        values: values.map((v) => (typeof v === "string" ? typedPlaceholder(v, name) : v))
      }
    return args
  }

  const located = calls.map((call) => {
    const args = call.name === "browser_act" ? redactAct(call.args) : call.args
    const content = jsonText(call.result["content"])
    for (const line of content.split("\n")) {
      const node = parseSnapshotNode(line)
      if (node?.ref !== undefined && node.name !== undefined)
        refs.set(node.ref, { role: node.role, name: node.name })
    }
    return {
      ...call,
      args,
      result: content === "" ? call.result : { ...call.result, content: redactFields(content) }
    }
  })

  const variants: Array<Variant> = []
  for (const [value, label] of placeholders) {
    if (value.length < MIN_ANYWHERE) {
      const field = fields.get(value)
      if (field !== undefined && value !== "")
        variants.push({
          pattern: bounded(`(?<=${escapeRegExp(field)}\\s*:?\\s*)${escapeRegExp(value)}`),
          placeholder: label,
          weight: value.length
        })
      continue
    }
    variants.push({
      pattern: bounded(sourcesOf(value).join("|")),
      placeholder: label,
      weight: value.length
    })
    const first = /^(\p{L}[\p{L}'’-]{2,})(?:\s+\p{L}[\p{L}'’.-]*){1,3}$/u.exec(value)?.[1]
    if (first !== undefined)
      variants.push({
        pattern: bounded(escapeRegExp(first)),
        placeholder: label.replace(/\}$/u, "_first}"),
        weight: first.length
      })
  }
  variants.sort((a, b) => b.weight - a.weight)
  const scrubText = (text: string): string => {
    const marked = variants.reduce(
      (current, variant, index) => current.replace(variant.pattern, unmatchableSentinel(index)),
      text
    )
    return variants.reduce(
      (current, variant, index) =>
        current.replaceAll(unmatchableSentinel(index), variant.placeholder),
      marked
    )
  }
  const choiceVariants = [...choices]
    .toSorted(([a], [b]) => b.length - a.length)
    .map(([label, picked]) => ({ pattern: bounded(escapeRegExp(label)), placeholder: picked }))
  const scrubChoices = (content: Json): Json =>
    typeof content !== "string"
      ? content
      : content
          .split("\n")
          .map((line) =>
            CHOICE_ROLES.has(parseSnapshotNode(line)?.role ?? "")
              ? line
              : choiceVariants.reduce(
                  (current, variant) => current.replace(variant.pattern, variant.placeholder),
                  line
                )
          )
          .join("\n")
  const scrubUrl = (url: string): string => {
    const origin = ORIGIN.exec(url)?.[0] ?? ""
    const rest = url.slice(origin.length)
    const hashAt = rest.indexOf("#")
    const beforeHash = hashAt < 0 ? rest : rest.slice(0, hashAt)
    const queryAt = beforeHash.indexOf("?")
    if (queryAt < 0) return `${origin}${scrubText(maskPathIds(beforeHash))}`
    const query = beforeHash
      .slice(queryAt + 1)
      .split("&")
      .map((pair) => {
        const key = pair.split("=", 1)[0] ?? ""
        return pair.includes("=") ? `${key}={${labelOf(decodedKey(key))}}` : "{value}"
      })
      .join("&")
    return `${origin}${scrubText(maskPathIds(beforeHash.slice(0, queryAt)))}?${query}`
  }
  const scrubLinkTargets = (text: string): string =>
    text.replace(LINK_TARGET, (_line, head: string, target: string) => {
      if (/^https?:/iu.test(target)) return `${head}${target}`
      const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(target)?.[1]
      return `${head}${scheme === undefined ? scrubUrl(target) : `${scheme}:{value}`}`
    })
  const scrubString = (text: string): string =>
    scrubLinkTargets(text)
      .split(URL_PART)
      .map((part, index) => (index % 2 === 1 ? scrubUrl(part) : scrubText(part)))
      .join("")
  const scrub = (value: Json): Json => {
    if (typeof value === "string") return scrubString(value)
    if (Array.isArray(value)) return value.map(scrub)
    if (isJsonObject(value)) return scrubObject(value)
    return value
  }
  const scrubObject = (value: JsonObject, keep?: string): Record<string, Json> =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        STRUCTURE.has(key) || key === keep ? item : scrub(item)
      ])
    )
  return {
    placeholders: new Set([...typed, ...choiceVariants.map((variant) => variant.placeholder)]),
    calls: located.map((call) => ({
      ...call,
      args: scrubObject(
        call.args,
        call.name === "browser_wait" && !WAIT_DATA.has(jsonText(call.args["condition"]))
          ? "value"
          : undefined
      ),
      result: (({ content, ...rest }) => ({ ...rest, content: scrubChoices(content ?? "") }))(
        scrubObject(call.result)
      )
    }))
  }
}
