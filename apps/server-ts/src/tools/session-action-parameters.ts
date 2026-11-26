import { Schema } from "effect"

import { SessionRefSchema, ToolDestinationSchema } from "./app-destination.js"

export const APP_OPEN_MODE = { offer: "offer", open: "open" } as const

export const RenameParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema,
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
    Schema.annotateEncoded({
      description: "New short human-readable Session name."
    })
  )
})

export const ArchiveParametersSchema = Schema.Struct({
  session_refs: Schema.Array(SessionRefSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(50))
    .annotate({
      description: "One to 50 exact session_ref values from session_list."
    })
})

export const SendMessageParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema,
  message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).pipe(
    Schema.annotateEncoded({
      description: "Self-contained message to deliver to the target Session."
    })
  )
})

export const ForwardMessageParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema.annotate({
    description: "Exact session_ref of the chat this capture belongs to, from session_list."
  })
})

export const AppOpenParametersSchema = Schema.Struct({
  destination: ToolDestinationSchema,
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)).pipe(
    Schema.annotateEncoded({
      description: "Short imperative label shown to the user, such as 'Open the Ops Space'."
    })
  ),
  mode: Schema.optionalKey(
    Schema.Literals(Object.values(APP_OPEN_MODE)).pipe(
      Schema.annotateEncoded({
        description:
          "offer (default): a card in chat the user may open. open: move the user there now; only when they asked to be taken there."
      })
    )
  )
})
