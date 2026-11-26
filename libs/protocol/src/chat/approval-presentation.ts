import { Schema } from "effect"
import type { JsonValue } from "../common/json.js"
import type { GoogleGrant } from "../google/contracts.js"
import { GoogleGrantSchema } from "../google/schema.js"
import type { Agrees, Assert } from "../common/type-agreement.js"

export const PREVIOUS_VALUE = { none: "none", previous: "previous" } as const

export type PreviousValue =
  | { readonly kind: typeof PREVIOUS_VALUE.none }
  | { readonly kind: typeof PREVIOUS_VALUE.previous; readonly text: string }

export interface ApprovalPresentationField {
  readonly label: string
  readonly value: string
  readonly from: PreviousValue
}

export interface ApprovalPresentationBody {
  readonly label: string
  readonly text: string
  readonly before: PreviousValue
}

export const EDITABLE_KIND = {
  fixed: "fixed",
  arguments: "arguments",
  mailDraft: "mail_draft"
} as const

interface EditableArguments {
  readonly fields: ReadonlyArray<string>
  readonly arguments: { readonly [key: string]: JsonValue }
}

export type ApprovalPresentationEditable =
  | (EditableArguments & { readonly kind: typeof EDITABLE_KIND.arguments })
  | (EditableArguments & {
      readonly kind: typeof EDITABLE_KIND.mailDraft
      readonly account: string
    })

export type ApprovalEditable =
  | { readonly kind: typeof EDITABLE_KIND.fixed }
  | ApprovalPresentationEditable

export const IMAGE_RING = { unmarked: "unmarked", marked: "marked" } as const

export type ImageRing =
  | { readonly kind: typeof IMAGE_RING.unmarked }
  | {
      readonly kind: typeof IMAGE_RING.marked
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }

export interface ApprovalPresentationImage {
  readonly src: string
  readonly width: number
  readonly height: number
  readonly ring: ImageRing
}

export const PRESENTATION_IMAGE = { none: "none", image: "image" } as const

export type PresentationImage =
  | { readonly kind: typeof PRESENTATION_IMAGE.none }
  | ({ readonly kind: typeof PRESENTATION_IMAGE.image } & ApprovalPresentationImage)

export interface ApprovalPresentationGrant {
  readonly grant: GoogleGrant
  readonly account: string
}

export const NEEDS_GRANT = { none: "none", needed: "needed" } as const

export type NeedsGrant =
  | { readonly kind: typeof NEEDS_GRANT.none }
  | ({ readonly kind: typeof NEEDS_GRANT.needed } & ApprovalPresentationGrant)

export const PRESENTATION_BODY = { none: "none", body: "body" } as const

export type PresentationBody =
  | { readonly kind: typeof PRESENTATION_BODY.none }
  | ({ readonly kind: typeof PRESENTATION_BODY.body } & ApprovalPresentationBody)

export const PRESENTATION_TEXT = { none: "none", text: "text" } as const

export type PresentationText =
  | { readonly kind: typeof PRESENTATION_TEXT.none }
  | { readonly kind: typeof PRESENTATION_TEXT.text; readonly text: string }

export type ApprovalAttachment =
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
  readonly attachments: ReadonlyArray<ApprovalAttachment>
  readonly title: string
  readonly subject: PresentationText
  readonly fields: ReadonlyArray<ApprovalPresentationField>
  readonly body: PresentationBody
  readonly approve_label: PresentationText
  readonly reject_label: PresentationText
  readonly note: PresentationText
  readonly why: PresentationText
  readonly grant_label: PresentationText
  readonly grant_rule: PresentationText
  readonly needs_grant: NeedsGrant
  readonly editable: ApprovalEditable
  readonly image: PresentationImage
}

export const APPROVAL_FIELD_LABEL = Object.freeze({
  site: "Site",
  secret: "Secret",
  /** A saved key's Vault name ("Todoist"), on the cards that use or ask for one. */
  key: "Key",
  /** The addresses a key goes to, joined with ", ". */
  sendTo: "Send only to",
  /** Why the agent asks, in its own words. */
  reason: "For",
  /** A saved card's safe title ("Visa ending 4242"), on the cards that pay with it. */
  card: "Card",
  /** The saved card's id in the Vault: what the desktop approves, never shown. */
  cardId: "Card id",
  /** The amount and its currency code as the agent gave them ("84.20 USD"). */
  amount: "Amount",
  /** The shop's origin, which the tab must be on. */
  shop: "Shop",
  /** The browser tab the payment happens in. */
  tab: "Tab",
  /** A payment frame's origin the card would be typed into. */
  frame: "Frame"
})

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

const INLINE_IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u

export const INLINE_IMAGE_PATTERN = INLINE_IMAGE

const EditableArgumentsSchema = Schema.Record(Schema.String, Schema.Json)

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

const imageSide = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: APPROVAL_PRESENTATION_LIMITS.imageSide })
)
const fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const editableFields = {
  fields: Schema.Array(boundedText(APPROVAL_PRESENTATION_LIMITS.fieldLabel)).check(
    Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.editableFields)
  ),
  arguments: EditableArgumentsSchema
}

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

const presentationText = (maximum: number) =>
  Schema.Union([
    tagged(PRESENTATION_TEXT.none),
    Schema.Struct({ kind: Schema.Literal(PRESENTATION_TEXT.text), text: boundedText(maximum) })
  ])

const previousValue = (maximum: number) =>
  Schema.Union([
    tagged(PREVIOUS_VALUE.none),
    Schema.Struct({ kind: Schema.Literal(PREVIOUS_VALUE.previous), text: boundedText(maximum) })
  ])

export const ApprovalAttachmentSchema = Schema.Union([
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

export const ApprovalPresentationSchema = Schema.Struct({
  attachments: Schema.Array(ApprovalAttachmentSchema).check(Schema.isMaxLength(500)),
  title: boundedText(APPROVAL_PRESENTATION_LIMITS.title),
  subject: presentationText(APPROVAL_PRESENTATION_LIMITS.subject),
  fields: Schema.Array(
    Schema.Struct({
      label: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldLabel),
      value: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue),
      from: previousValue(APPROVAL_PRESENTATION_LIMITS.fieldValue)
    })
  ).check(Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.fields)),
  body: Schema.Union([
    tagged(PRESENTATION_BODY.none),
    Schema.Struct({
      kind: Schema.Literal(PRESENTATION_BODY.body),
      label: boundedText(APPROVAL_PRESENTATION_LIMITS.bodyLabel),
      text: boundedText(APPROVAL_PRESENTATION_LIMITS.bodyText),
      before: previousValue(APPROVAL_PRESENTATION_LIMITS.bodyText)
    })
  ]),
  approve_label: presentationText(APPROVAL_PRESENTATION_LIMITS.decisionLabel),
  reject_label: presentationText(APPROVAL_PRESENTATION_LIMITS.decisionLabel),
  note: presentationText(APPROVAL_PRESENTATION_LIMITS.note),
  why: presentationText(APPROVAL_PRESENTATION_LIMITS.why),
  grant_label: presentationText(APPROVAL_PRESENTATION_LIMITS.decisionLabel),
  grant_rule: presentationText(APPROVAL_PRESENTATION_LIMITS.grantRule),
  needs_grant: Schema.Union([
    tagged(NEEDS_GRANT.none),
    Schema.Struct({
      kind: Schema.Literal(NEEDS_GRANT.needed),
      grant: GoogleGrantSchema,
      account: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue)
    })
  ]),
  editable: Schema.Union([
    tagged(EDITABLE_KIND.fixed),
    Schema.Struct({ kind: Schema.Literal(EDITABLE_KIND.arguments), ...editableFields }),
    Schema.Struct({
      kind: Schema.Literal(EDITABLE_KIND.mailDraft),
      ...editableFields,
      account: boundedText(APPROVAL_PRESENTATION_LIMITS.fieldValue)
    })
  ]),
  image: Schema.Union([
    tagged(PRESENTATION_IMAGE.none),
    Schema.Struct({
      kind: Schema.Literal(PRESENTATION_IMAGE.image),
      src: Schema.String.check(
        Schema.isMaxLength(APPROVAL_PRESENTATION_LIMITS.imageSrc),
        Schema.isPattern(INLINE_IMAGE)
      ),
      width: imageSide,
      height: imageSide,
      ring: Schema.Union([
        tagged(IMAGE_RING.unmarked),
        Schema.Struct({
          kind: Schema.Literal(IMAGE_RING.marked),
          x: fraction,
          y: fraction,
          width: fraction,
          height: fraction
        })
      ])
    })
  ])
})

export type ApprovalPresentationAgrees = Assert<
  Agrees<typeof ApprovalPresentationSchema.Type, ApprovalPresentation>
>

export function canDenyApprovalByReply(approval: { readonly action: string }): boolean {
  return approval.action !== "verify_outcome"
}
