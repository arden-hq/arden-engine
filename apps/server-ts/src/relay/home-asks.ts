import { Schema } from "effect"

export const HomeAsks = Schema.Struct({
  asks: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("question"),
        question_id: Schema.String,
        session_id: Schema.String,
        place: Schema.String,
        prompt: Schema.String
      }),
      Schema.Struct({
        kind: Schema.Literal("approval"),
        tool_id: Schema.String,
        run_id: Schema.String,
        session_id: Schema.String,
        place: Schema.String,
        title: Schema.String,
        asked_at: Schema.String
      })
    ])
  )
})
