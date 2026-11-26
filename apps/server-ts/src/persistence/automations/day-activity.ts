import { Context, type Effect } from "effect"

export interface DayTaskEvent {
  readonly itemId: string
  readonly title: string
  readonly spaceName: string | undefined
  readonly type: string
  readonly at: string
  readonly summary: string | undefined
}

export interface DayItem {
  readonly itemId: string
  readonly source: string
  readonly receivedAt: string
  readonly sender: string | undefined
  readonly title: string
  readonly snippet: string
  readonly sentByOwner: boolean
}

export class DayActivity extends Context.Service<
  DayActivity,
  {
    readonly read: (range: {
      readonly start: string
      readonly end: string
    }) => Effect.Effect<
      { readonly taskEvents: ReadonlyArray<DayTaskEvent>; readonly items: ReadonlyArray<DayItem> },
      Error
    >
  }
>()("@arden-hq/server/persistence/automations/DayActivity") {}
