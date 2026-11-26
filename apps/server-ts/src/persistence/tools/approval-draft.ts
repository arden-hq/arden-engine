import {
  APPROVAL_PRESENTATION_LIMITS,
  EDITABLE_KIND,
  IMAGE_RING,
  INLINE_IMAGE_PATTERN,
  NEEDS_GRANT,
  PRESENTATION_BODY,
  PRESENTATION_IMAGE,
  PRESENTATION_TEXT,
  PREVIOUS_VALUE,
  type ApprovalAttachment,
  type ApprovalPresentation,
  type ApprovalPresentationEditable,
  type ApprovalPresentationGrant,
  type PresentationText,
  type PreviousValue
} from "@arden-hq/protocol/chat"
import { ApprovalAttachmentSchema } from "@arden-hq/protocol/effect/chat"
import { GoogleGrantSchema } from "@arden-hq/protocol/effect/google"
import { isRecord } from "@arden-hq/std/json"
import type { JsonObject } from "../json.js"
import { cutText } from "@arden-hq/std/text"
import { Option, Schema } from "effect"

export interface ApprovalFieldDraft {
  readonly label: string
  readonly value: string
  readonly from?: string
}

interface ApprovalBodyDraft {
  readonly label: string
  readonly text: string
  readonly before?: string
}

interface ApprovalImageDraft {
  readonly src: string
  readonly width: number
  readonly height: number
  readonly ring?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

export interface ApprovalPresentationDraft {
  readonly attachments?: ReadonlyArray<ApprovalAttachment>
  readonly title: string
  readonly subject?: string
  readonly fields: ReadonlyArray<ApprovalFieldDraft>
  readonly body?: ApprovalBodyDraft
  readonly approve_label?: string
  readonly reject_label?: string
  readonly note?: string
  readonly why?: string
  readonly grant_label?: string
  readonly grant_rule?: string
  readonly needs_grant?: ApprovalPresentationGrant
  readonly editable?: ApprovalPresentationEditable
  readonly image?: ApprovalImageDraft
}

const text = (value: string | undefined): PresentationText =>
  value === undefined
    ? { kind: PRESENTATION_TEXT.none }
    : { kind: PRESENTATION_TEXT.text, text: value }

const previous = (value: string | undefined): PreviousValue =>
  value === undefined
    ? { kind: PREVIOUS_VALUE.none }
    : { kind: PREVIOUS_VALUE.previous, text: value }

export const wireApprovalPresentation = (
  draft: ApprovalPresentationDraft
): ApprovalPresentation => ({
  attachments: draft.attachments ?? [],
  title: draft.title,
  subject: text(draft.subject),
  fields: draft.fields.map((field) => ({
    label: field.label,
    value: field.value,
    from: previous(field.from)
  })),
  body:
    draft.body === undefined
      ? { kind: PRESENTATION_BODY.none }
      : {
          kind: PRESENTATION_BODY.body,
          label: draft.body.label,
          text: draft.body.text,
          before: previous(draft.body.before)
        },
  approve_label: text(draft.approve_label),
  reject_label: text(draft.reject_label),
  note: text(draft.note),
  why: text(draft.why),
  grant_label: text(draft.grant_label),
  grant_rule: text(draft.grant_rule),
  needs_grant:
    draft.needs_grant === undefined
      ? { kind: NEEDS_GRANT.none }
      : { kind: NEEDS_GRANT.needed, ...draft.needs_grant },
  editable: draft.editable ?? { kind: EDITABLE_KIND.fixed },
  image:
    draft.image === undefined
      ? { kind: PRESENTATION_IMAGE.none }
      : {
          kind: PRESENTATION_IMAGE.image,
          src: draft.image.src,
          width: draft.image.width,
          height: draft.image.height,
          ring:
            draft.image.ring === undefined
              ? { kind: IMAGE_RING.unmarked }
              : { kind: IMAGE_RING.marked, ...draft.image.ring }
        }
})

export const storedApprovalPresentation = (value: unknown): ApprovalPresentation | undefined => {
  const draft = cleanApprovalDraft(value)
  return draft === undefined ? undefined : wireApprovalPresentation(draft)
}

const sanitizeImage = (value: unknown): ApprovalImageDraft | undefined => {
  if (!isRecord(value)) return undefined
  const { src, width, height, ring } = value
  const side = (n: unknown): n is number =>
    typeof n === "number" &&
    Number.isInteger(n) &&
    n > 0 &&
    n <= APPROVAL_PRESENTATION_LIMITS.imageSide
  if (
    typeof src !== "string" ||
    src.length > APPROVAL_PRESENTATION_LIMITS.imageSrc ||
    !INLINE_IMAGE_PATTERN.test(src) ||
    !side(width) ||
    !side(height)
  )
    return undefined
  const fraction = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1
  const marked =
    isRecord(ring) &&
    fraction(ring.x) &&
    fraction(ring.y) &&
    fraction(ring.width) &&
    fraction(ring.height)
      ? { x: ring.x, y: ring.y, width: ring.width, height: ring.height }
      : undefined
  return { src, width, height, ...(marked === undefined ? {} : { ring: marked }) }
}

const invisibleControlCharacters =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu

const sanitizeInline = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const sanitized = value.replace(invisibleControlCharacters, "").replace(/\s+/gu, " ").trim()
  if (sanitized.length === 0) return undefined
  return cutText(sanitized, maximum)
}

const sanitizeBodyText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const sanitized = value.replace(/\r\n?/gu, "\n").replace(invisibleControlCharacters, "")
  if (sanitized.trim().length === 0) return undefined
  return cutText(sanitized, APPROVAL_PRESENTATION_LIMITS.bodyText, { suffix: "\n… [truncated]" })
}

export const cleanApprovalDraft = (value: unknown): ApprovalPresentationDraft | undefined => {
  if (!isRecord(value)) return undefined
  const title = sanitizeInline(value.title, APPROVAL_PRESENTATION_LIMITS.title)
  if (title === undefined || !Array.isArray(value.fields)) return undefined
  const subject = sanitizeInline(value.subject, APPROVAL_PRESENTATION_LIMITS.subject)
  const approveLabel = sanitizeInline(
    value.approve_label,
    APPROVAL_PRESENTATION_LIMITS.decisionLabel
  )
  const rejectLabel = sanitizeInline(value.reject_label, APPROVAL_PRESENTATION_LIMITS.decisionLabel)
  const note = sanitizeInline(value.note, APPROVAL_PRESENTATION_LIMITS.note)
  const why = sanitizeInline(value.why, APPROVAL_PRESENTATION_LIMITS.why)
  const grantLabel = sanitizeInline(value.grant_label, APPROVAL_PRESENTATION_LIMITS.decisionLabel)
  const grantRule = sanitizeInline(value.grant_rule, APPROVAL_PRESENTATION_LIMITS.grantRule)

  const fields: Array<ApprovalFieldDraft> = []
  for (const rawField of value.fields.slice(0, APPROVAL_PRESENTATION_LIMITS.fields)) {
    if (!isRecord(rawField)) continue
    const label = sanitizeInline(rawField.label, APPROVAL_PRESENTATION_LIMITS.fieldLabel)
    const fieldValue = sanitizeInline(rawField.value, APPROVAL_PRESENTATION_LIMITS.fieldValue)
    const from = sanitizeInline(rawField.from, APPROVAL_PRESENTATION_LIMITS.fieldValue)
    if (label !== undefined && fieldValue !== undefined)
      fields.push({ label, value: fieldValue, ...(from === undefined ? {} : { from }) })
  }

  const attachments = Array.isArray(value.attachments)
    ? value.attachments.slice(0, 500).map((raw): ApprovalAttachment => {
        const item = isRecord(raw) ? raw : {}
        const name = sanitizeInline(item.name, 512) ?? "Unnamed file"
        const media_type = sanitizeInline(item.media_type, 256) ?? "application/octet-stream"
        const decoded = Schema.decodeUnknownOption(ApprovalAttachmentSchema)({
          ...item,
          name,
          media_type
        })
        return Option.isSome(decoded)
          ? decoded.value
          : {
              kind: "link",
              name,
              media_type,
              url: typeof item.url === "string" ? cutText(item.url, 8192) : ""
            }
      })
    : undefined
  const editable = sanitizeEditable(value.editable)
  const needsGrant = sanitizeGrant(value.needs_grant)
  const image = sanitizeImage(value.image)

  let body: ApprovalBodyDraft | undefined
  if (isRecord(value.body)) {
    const label = sanitizeInline(value.body.label, APPROVAL_PRESENTATION_LIMITS.bodyLabel)
    const text = sanitizeBodyText(value.body.text)
    const before = sanitizeBodyText(value.body.before)
    if (label !== undefined && text !== undefined)
      body = { label, text, ...(before === undefined ? {} : { before }) }
  }

  return {
    title,
    ...(subject === undefined ? {} : { subject }),
    fields,
    ...(attachments === undefined ? {} : { attachments }),
    ...(body === undefined ? {} : { body }),
    ...(approveLabel === undefined ? {} : { approve_label: approveLabel }),
    ...(rejectLabel === undefined ? {} : { reject_label: rejectLabel }),
    ...(note === undefined ? {} : { note }),
    ...(why === undefined ? {} : { why }),
    ...(grantLabel === undefined ? {} : { grant_label: grantLabel }),
    ...(grantRule === undefined ? {} : { grant_rule: grantRule }),
    ...(needsGrant === undefined ? {} : { needs_grant: needsGrant }),
    ...(editable === undefined ? {} : { editable }),
    ...(image === undefined ? {} : { image })
  }
}

const sanitizeGrant = (value: unknown): ApprovalPresentationGrant | undefined => {
  if (!isRecord(value)) return undefined
  const decoded = Schema.decodeUnknownOption(GoogleGrantSchema)(value.grant)
  const account = sanitizeInline(value.account, APPROVAL_PRESENTATION_LIMITS.fieldValue)
  return Option.isSome(decoded) && account !== undefined
    ? { grant: decoded.value, account }
    : undefined
}

const sanitizeEditable = (value: unknown): ApprovalPresentationEditable | undefined => {
  if (!isRecord(value) || !Array.isArray(value.fields) || !isRecord(value.arguments))
    return undefined
  const fields = value.fields.filter((field): field is string => typeof field === "string")
  if (fields.length === 0 || fields.length > APPROVAL_PRESENTATION_LIMITS.editableFields) {
    return undefined
  }
  const encoded = JSON.stringify(value.arguments)
  if (encoded.length > APPROVAL_PRESENTATION_LIMITS.editableArguments) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(EditableArgumentsSchema))(
    encoded
  )
  if (Option.isNone(decoded)) return undefined
  const edit = { fields, arguments: decoded.value }
  const account = sanitizeInline(value.account, APPROVAL_PRESENTATION_LIMITS.fieldValue)
  return account === undefined
    ? { kind: EDITABLE_KIND.arguments, ...edit }
    : { kind: EDITABLE_KIND.mailDraft, ...edit, account }
}

const EditableArgumentsSchema = Schema.Record(Schema.String, Schema.Json)

export const draftPayload = (presentation: ApprovalPresentationDraft): JsonObject => ({
  title: presentation.title,
  ...(presentation.subject === undefined ? {} : { subject: presentation.subject }),
  fields: presentation.fields.map((field) => ({ label: field.label, value: field.value })),
  ...(presentation.body === undefined
    ? {}
    : { body: { label: presentation.body.label, text: presentation.body.text } }),
  ...(presentation.approve_label === undefined
    ? {}
    : { approve_label: presentation.approve_label }),
  ...(presentation.reject_label === undefined ? {} : { reject_label: presentation.reject_label }),
  ...(presentation.note === undefined ? {} : { note: presentation.note }),
  ...(presentation.why === undefined ? {} : { why: presentation.why }),
  ...(presentation.grant_label === undefined ? {} : { grant_label: presentation.grant_label }),
  ...(presentation.grant_rule === undefined ? {} : { grant_rule: presentation.grant_rule })
})
