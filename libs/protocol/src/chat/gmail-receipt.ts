import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import { IsoDateTimeStringSchema, withExtras } from "../common/schema.js"
import type { GmailSendReceipt } from "./history.js"

export const GmailSendReceiptSchema: Schema.Codec<GmailSendReceipt> = withExtras({
  kind: Schema.Literal("gmail_send_v1"),
  provider_message_id: Schema.NonEmptyString,
  provider_thread_id: Schema.NonEmptyString,
  recipient: Schema.NonEmptyString,
  confirmed_at: IsoDateTimeStringSchema
})

/** @internal Compile-time check that the schema and the type agree. */
export type GmailSendReceiptAgrees = Assert<
  Agrees<typeof GmailSendReceiptSchema.Type, GmailSendReceipt>
>
