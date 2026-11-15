import { Schema } from "effect"
import { MemoryCaptureBatchSchema } from "../memory/store.js"

export const MAX_HANDLER_ITEM_ATTEMPTS = 3

export const HandlerItemInputSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
  data: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("memory"), batch: MemoryCaptureBatchSchema }),
    Schema.Struct({
      kind: Schema.Literal("daily"),
      date: Schema.NonEmptyString,
      timezone: Schema.NonEmptyString,
      markdown: Schema.NonEmptyString
    }),
    Schema.Struct({
      kind: Schema.Literal("wiki"),
      processedHead: Schema.NullOr(Schema.NonEmptyString),
      sourceHead: Schema.NonEmptyString,
      markdown: Schema.NonEmptyString
    }).annotate({ parseOptions: { onExcessProperty: "error" } })
  ])
})
export type HandlerItemInput = typeof HandlerItemInputSchema.Type
export type HandlerItemData = HandlerItemInput["data"]
export type HandlerItemKind = HandlerItemData["kind"]
export type HandlerItemDataOf<K extends HandlerItemKind> = Extract<
  HandlerItemData,
  { readonly kind: K }
>

export const HandlerItemRefSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HANDLER_ITEM_ATTEMPTS }))
})
export type HandlerItemRef = typeof HandlerItemRefSchema.Type

const itemFields = {
  ...HandlerItemRefSchema.fields,
  previousRunId: Schema.NullOr(Schema.NonEmptyString),
  reviewed: Schema.Natural,
  skipped: Schema.Natural,
  input: HandlerItemInputSchema
}
export const HandlerItemSchema = Schema.Union([
  Schema.Struct({
    ...itemFields,
    phase: Schema.Literal("pending"),
    runId: Schema.NullOr(Schema.NonEmptyString)
  }),
  Schema.Struct({
    ...itemFields,
    phase: Schema.Literal("settled"),
    runId: Schema.NonEmptyString,
    failure: Schema.NullOr(Schema.NonEmptyString)
  })
])
export type HandlerItem = typeof HandlerItemSchema.Type

export const handlerItemClientId = (item: HandlerItemRef): string =>
  `handler-item-${item.id}-${item.attempt}`
