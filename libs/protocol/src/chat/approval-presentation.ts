import { cutText } from "@arden-hq/std/text"
import { Schema } from "effect"
import type { JsonValue } from "../common/json.js"
import type { GoogleGrant } from "../google/contracts.js"
import { GoogleGrantSchema } from "../google/schema.js"
import { isRecord } from "@arden-hq/std/json"

export interface ApprovalPresentationField {
  readonly label: string
  readonly value: string
  /** The value this call replaces; the card shows it struck before the new one. */
  readonly from?: string
}

export interface ApprovalPresentationBody {
  readonly label: string
  readonly text: string
  /** The text this call replaces; the card shows the change between them. */
  readonly before?: string
}

/** The call's arguments a card may change in place before approving. */
export interface ApprovalPresentationEditable {
  /** Top-level arguments the person may change; the rest stay as asked. */
  readonly fields: ReadonlyArray<string>
  /** Every argument as the model asked for it. */
  readonly arguments: { readonly [key: string]: JsonValue }
}

/** A picture of what the call acts on (a browser action's element on its
 *  page): an inline PNG or JPEG only, never a URL the app would fetch.
 *  `ring` marks the element, as fractions of the picture. */
export interface ApprovalPresentationImage {
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

/**
 * A Google permission the account has not given yet. The app asks Google for
 * it when the person approves, and approves only once Google granted it.
 */
export interface ApprovalPresentationGrant {
  readonly grant: GoogleGrant
  /** The connected Google account's email. */
  readonly account: string
}

type ApprovalAttachment =
  | {
      readonly kind: "file"
      readonly index: number
      readonly name: string
      readonly media_type: string
      readonly size: number
    }
  | {
      readonly kind: "link"
      readonly name: string
      readonly media_type: string
      readonly url: string
    }

export interface ApprovalPresentation {
  readonly attachments?: ReadonlyArray<ApprovalAttachment>
  readonly title: string
  /** What the title is about — the path, name or address the card identifies. */
  readonly subject?: string
  readonly fields: ReadonlyArray<ApprovalPresentationField>
  readonly body?: ApprovalPresentationBody
  /** The tool's own verb for approving, in place of "Approve". */
  readonly approve_label?: string
  /** The tool's own verb for rejecting, in place of "Reject". */
  readonly reject_label?: string
  /**
   * Why this card came to the user rather than running: in Auto, the Helper's
   * reason; otherwise the tool's own caution, such as a file outside the
   * Local folders.
   */
  readonly note?: string
  /**
   * Why Arden asked rather than ran the call (the Helper's reason, or the
   * rule that always asks): kept behind a question icon, never in the card's
   * body. A caution the owner must see goes in `note`.
   */
  readonly why?: string
  /** The tool's own words for its folder grant, in place of "Allow for this Space" or "Chat". */
  readonly grant_label?: string
  /**
   * What the card's "Always allow" keeps, as its label names it: command
   * prefixes ("modal …") or the Helper's words for the action. The one source
   * of that label; never shown as a row.
   */
  readonly grant_rule?: string
  /** Present when approving needs a Google permission the account lacks. */
  readonly needs_grant?: ApprovalPresentationGrant
  /** Present when the tool takes edits on its card. */
  readonly editable?: ApprovalPresentationEditable
  readonly image?: ApprovalPresentationImage
}

export const APPROVAL_FIELD_LABEL = Object.freeze({ site: "Site", secret: "Secret" })

export const APPROVAL_PRESENTATION_LIMITS = Object.freeze({
  title: 160,
  subject: 512,
  decisionLabel: 32,
  note: 240,
  why: 240,
  grantRule: 512,
  fields: 16,
  editableFields: 16,
  editableArguments: 200_000,
  fieldLabel: 64,
  fieldValue: 4_096,
  bodyLabel: 64,
  bodyText: 500_000,
  imageSrc: 200_000,
  imageSide: 4_096
})

const ApprovalAttachmentSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 499 })),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    media_type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  }),
  Schema.Struct({
    kind: Schema.Literal("link"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    media_type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    url: Schema.String.check(Schema.isMaxLength(8192))
  })
])
const AttachmentsSchema = Schema.Array(ApprovalAttachmentSchema).check(Schema.isMaxLength(500))

const INLINE_IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u

const sanitizeImage = (value: unknown): ApprovalPresentationImage | undefined => {
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
    !INLINE_IMAGE.test(src) ||
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

/**
 * Projects untrusted approval details into the one bounded public shape.
 * Unknown keys and malformed rows are dropped; executor approval data never
 * enters this function or the returned object.
 */
export const sanitizeApprovalPresentation = (value: unknown): ApprovalPresentation | undefined => {
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

  const fields: Array<ApprovalPresentationField> = []
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
        return decoded._tag === "Some"
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

  let body: ApprovalPresentationBody | undefined
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
  return decoded._tag === "Some" && account !== undefined
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
  const decoded = Schema.decodeUnknownOption(EditableArgumentsSchema)(JSON.parse(encoded))
  return decoded._tag === "Some" ? { fields, arguments: decoded.value } : undefined
}

const EditableArgumentsSchema = Schema.Record(Schema.String, Schema.Json)

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const imageSide = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: APPROVAL_PRESENTATION_LIMITS.imageSide })
)
const fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export const ApprovalPresentationSchema = Schema.Struct({
  attachments: Schema.optionalKey(AttachmentsSchema),
  title: boundedText(APPROVAL_PRESENTATION_LIMITS.title),
  subject: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.subject)),
  fields: Schema.Array(
    Schema.Struct({
      label: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldLabel),
      value: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue),
      from: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue))
    })
  ).check(Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.fields)),
  body: Schema.optionalKey(
    Schema.Struct({
      label: boundedText(APPROVAL_PRESENTATION_LIMITS.bodyLabel),
      text: boundedText(APPROVAL_PRESENTATION_LIMITS.bodyText),
      before: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.bodyText))
    })
  ),
  approve_label: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.decisionLabel)),
  reject_label: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.decisionLabel)),
  note: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.note)),
  why: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.why)),
  grant_label: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.decisionLabel)),
  grant_rule: Schema.optionalKey(boundedText(APPROVAL_PRESENTATION_LIMITS.grantRule)),
  needs_grant: Schema.optionalKey(
    Schema.Struct({
      grant: GoogleGrantSchema,
      account: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue)
    })
  ),
  editable: Schema.optionalKey(
    Schema.Struct({
      fields: Schema.Array(boundedText(APPROVAL_PRESENTATION_LIMITS.fieldLabel)).check(
        Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.editableFields)
      ),
      arguments: EditableArgumentsSchema
    })
  ),
  image: Schema.optionalKey(
    Schema.Struct({
      src: Schema.String.check(
        Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.imageSrc),
        Schema.isPattern(INLINE_IMAGE)
      ),
      width: imageSide,
      height: imageSide,
      ring: Schema.optionalKey(
        Schema.Struct({ x: fraction, y: fraction, width: fraction, height: fraction })
      )
    })
  )
})

/** Outcome checks ask what happened; typed chat only refuses a permission request. */
export function canDenyApprovalByReply(approval: {
  readonly action?: string | undefined
}): boolean {
  return approval.action !== "verify_outcome"
}
