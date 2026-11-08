import { Context, Effect } from "effect"

export class UnitOfWork extends Context.Service<
  UnitOfWork,
  {
    readonly afterCommit: (notify: Effect.Effect<void>) => Effect.Effect<void>
    readonly markTold: (key: string, through?: number) => Effect.Effect<void>
    readonly toldThrough: (key: string) => Effect.Effect<number | undefined>
  }
>()("@arden-hq/server/persistence/UnitOfWork") {}

export type Told = Map<string, number>

export const rememberTold = (told: Told, key: string, through = Number.POSITIVE_INFINITY) =>
  void told.set(key, Math.max(told.get(key) ?? Number.NEGATIVE_INFINITY, through))

export const makeUnitOfWork = (
  afterCommit: (notify: Effect.Effect<void>) => Effect.Effect<void>
): UnitOfWork["Service"] => {
  const told: Told = new Map()
  return UnitOfWork.of({
    afterCommit,
    markTold: (key, through) => Effect.sync(() => rememberTold(told, key, through)),
    toldThrough: (key) => Effect.sync(() => told.get(key))
  })
}

export const toldKey = {
  question: (questionId: string) => `question:${questionId}`,
  card: (runId: string, toolCallId: string) => `card:${runId}:${toolCallId}`,
  session: (sessionId: string) => `session:${sessionId}`
} as const
