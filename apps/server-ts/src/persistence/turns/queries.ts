import { Context, Effect, Schema } from "effect"

export class SessionTurnQueryError extends Schema.TaggedError<SessionTurnQueryError>()(
  "SessionTurnQueryError",
  {
    reason: Schema.tag("storage"),
    sessionId: Schema.NonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface SessionTurnShell {
  readonly turnId: string
  readonly messageStartSeq: number
  readonly messageEndSeq: number
  readonly startedAt: string
  readonly endedAt: string
  readonly failure: TurnFailure | undefined
}

interface TurnFailure {
  readonly code: string
  readonly message: string
}

export class SessionTurnQueries extends Context.Service<
  SessionTurnQueries,
  {
    readonly shellsFor: (
      sessionId: string,
      turnIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<SessionTurnShell>, SessionTurnQueryError>
  }
>()("@arden-hq/server/persistence/turns/SessionTurnQueries") {}
