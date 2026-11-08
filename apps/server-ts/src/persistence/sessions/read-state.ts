import { Context, Effect, Schema } from "effect"

export interface SessionReadMark {
  readonly hasUnread: boolean
}

export class SessionReadStateError extends Schema.TaggedError<SessionReadStateError>()(
  "SessionReadStateError",
  {
    operation: Schema.Literal("mark"),
    sessionId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class SessionReadState extends Context.Service<
  SessionReadState,
  {
    readonly mark: (
      sessionId: string
    ) => Effect.Effect<SessionReadMark | null, SessionReadStateError>
  }
>()("@arden-hq/server/persistence/sessions/SessionReadState") {}
