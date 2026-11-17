import { Context, type Effect } from "effect"

/** One change to a Task: it was created, finished, failed, or started or stopped waiting. */
export interface DayTaskEvent {
  readonly itemId: string
  readonly title: string
  readonly spaceName: string | undefined
  readonly type: string
  readonly at: string
  readonly summary: string | undefined
}

/** One stored item (a mail, a notification, a calendar change) that arrived. */
export interface DayItem {
  readonly itemId: string
  readonly source: string
  readonly receivedAt: string
  readonly sender: string | undefined
  readonly title: string
  readonly snippet: string
  readonly spaceName: string | undefined
  /** A mail the owner sent themselves, kept because its thread belongs to a Space. */
  readonly sentByOwner: boolean
}

/** What happened outside the chats between two instants (`end` exclusive), in time order. */
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
