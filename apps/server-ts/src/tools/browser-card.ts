import { parseJsonTextOrUndefined } from "@arden-hq/protocol/common"
import { quoted } from "@arden-hq/std/count"
import { Schema } from "effect"
import { BROWSER_ACT_ACTION } from "../browser/service.js"
import type { JsonObject } from "../persistence/json.js"
import type { ActParametersSchema } from "./browser-parameters.js"
import { resolveRef, uiTargetData } from "./ui-target.js"

type ActInput = typeof ActParametersSchema.Type

const TargetSeenSchema = Schema.Struct({
  context: Schema.NullOr(Schema.String),
  crop: Schema.NullOr(
    Schema.Struct({
      src: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
      ring: Schema.optionalKey(
        Schema.Struct({
          x: Schema.Number,
          y: Schema.Number,
          width: Schema.Number,
          height: Schema.Number
        })
      )
    })
  )
})
type TargetSeen = typeof TargetSeenSchema.Type
export const decodeTargetSeen = Schema.decodeUnknownOption(TargetSeenSchema)

export const targetLabel = (
  described: string | undefined
): { readonly role: string; readonly name: string } | undefined => {
  if (described === undefined) return undefined
  const space = described.indexOf(" ")
  const role = space < 0 ? described : described.slice(0, space)
  const rest = space < 0 ? "" : described.slice(space + 1)
  const parsed = parseJsonTextOrUndefined(rest)
  const name = typeof parsed === "string" ? parsed : ""
  return { role, name: name.trim() }
}

const actApprovalTitle = (
  input: ActInput,
  label: { readonly role: string; readonly name: string } | undefined
): string => {
  const name = label?.name || input.target?.name || input.target?.value || ""
  const unnamed = label === undefined ? "this" : `this ${label.role}`
  const what = name.length > 0 ? quoted(name, 80) : unnamed
  switch (input.action) {
    case BROWSER_ACT_ACTION.click:
      return `Click ${what}?`
    case BROWSER_ACT_ACTION.dblclick:
      return `Double-click ${what}?`
    case BROWSER_ACT_ACTION.hover:
      return `Point at ${what}?`
    case BROWSER_ACT_ACTION.focus:
      return `Focus ${what}?`
    case BROWSER_ACT_ACTION.fill:
    case BROWSER_ACT_ACTION.type:
      return name.length > 0 ? `Type into ${what}?` : "Type into this field?"
    case BROWSER_ACT_ACTION.select:
      return `Choose in ${what}?`
    case BROWSER_ACT_ACTION.check:
      return `Tick ${what}?`
    case BROWSER_ACT_ACTION.uncheck:
      return `Untick ${what}?`
    case BROWSER_ACT_ACTION.press:
      return `Press ${input.value ?? "a key"}?`
    case BROWSER_ACT_ACTION.scroll:
      return `Scroll ${input.direction ?? "down"}?`
  }
}

export type ActApprovalPresentation = {
  readonly image?: {
    readonly width: number
    readonly height: number
    readonly src: string
    readonly ring?: {
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  }
  readonly body?: { readonly label: string; readonly text: string }
  readonly title: string
  readonly subject: string
  readonly fields: { label: string; value: string }[]
}

export const actApprovalPresentation = (
  input: ActInput,
  label: { readonly role: string; readonly name: string } | undefined,
  seen: TargetSeen | undefined
): ActApprovalPresentation => {
  const body = withheldTextNotice(input)
  const crop = seen?.crop ?? undefined
  const near = seen?.context ?? undefined
  return {
    title: actApprovalTitle(input, label),
    subject: new URL(input.origin).host,
    fields: [
      ...(crop === undefined && near !== undefined ? [{ label: "On the page", value: near }] : []),
      ...(input.secret === undefined ? [] : [{ label: "Saved secret", value: input.secret }])
    ],
    ...(body === undefined ? {} : { body }),
    ...(crop === undefined ? {} : { image: crop })
  }
}

const withheldTextNotice = (
  input: ActInput
): { readonly label: string; readonly text: string } | undefined => {
  if (input.action === BROWSER_ACT_ACTION.press) return undefined
  const entries =
    input.values !== undefined && input.values.length > 0
      ? input.values.length
      : Number(input.value !== undefined && input.value.length > 0)
  if (entries === 0) return undefined
  return {
    label: "Text to enter",
    text:
      entries === 1
        ? "Withheld: a typed value can be a password. Check the field in the browser tab before you allow this."
        : `Withheld: ${entries} typed values, which can include passwords. Check the fields in the browser tab before you allow this.`
  }
}

export const approvalTarget = (
  input: ActInput,
  described: string | undefined,
  seen: TargetSeen | undefined
): { readonly ui_target?: JsonObject } => {
  const target = input.target
  if (target === undefined) return {}
  if (target.node_ref === undefined)
    return target.kind === undefined || target.value === undefined
      ? {}
      : uiTargetData({
          kind: "selector",
          by: target.kind,
          value: target.value,
          name: target.name ?? null
        })
  return uiTargetData(
    resolveRef({
      ref: target.node_ref,
      label: described,
      near: seen?.context ?? undefined,
      why: "it is not in this run's latest interactive snapshot of this tab"
    })
  )
}
