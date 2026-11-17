# Add an outside event

Use this when something outside Arden (an email, a GitHub notification, an app
event) should start an Automation. It is one real source shown file by file:
`email.received` (old repo commit `3e52a1212`). Copy its shape. Outside code
never queues a run itself: a producer publishes its events.

A source provides four things:

- `eventKey`: the event's identity. A run is queued once per `eventType:eventKey`.
- A cursor: a string saved in the same transaction as the queued runs.
- `context`: JSON that trigger fields such as `item.title` are read from.
- The text the run is told: one case in `event-text.ts` and one in `event-words.ts`.

## 1. Define the event

In `libs/protocol/src/automations/triggers.ts`, add the type to
`AUTOMATION_EVENT_TYPES` and an entry to `AUTOMATION_EVENTS`. A field is a path in `context`:

```ts
  "email.received": {
    event_type: "email.received",
    audience: "user",
    label: "New email",
    name: "New email",
    sentence:
      "Runs for each new email Arden fetches from a connected Gmail account, about five minutes after it arrives.",
    each: "new email",
    fields: [
      { field: "item.title", label: "Subject", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "item.sender", label: "From", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
```

## 2. Write the producer

`apps/server-ts/src/automations/producers/connection-item.ts` builds the event
and polls every minute (`always`):

```ts
    case "gmail":
      return {
        eventType: "email.received",
        eventKey: row.itemId,
        producedBy: null,
        chainDepth: 0,
        touches: { target: gmailThreadTarget(row.threadKey), changedAt: row.receivedAt },
        context: { item }
      }
…
export const emailItemEventProducer: AutomationEventProducer<"email.received", AutomationTriggers> =
  {
    eventType: "email.received",
    available: ({ googleAccounts }) => googleAccounts.some(hasReadyGmail),
    source: {
      kind: "always",
      poll: AutomationTriggers.use((triggers) => triggers.publishConnectionItems())
    },
    failureMessage: "Connection item event publication remains pending"
  }
```

An outside event has `producedBy: null` and `chainDepth: 0`. `source.kind` is
`always`, `on_demand` (only while an Automation listens), `live` (a stream, like
`mcp-event.ts`) or `feed` (never polled).

Something that arrived (a mail, a notification, a changed calendar event) is
stored as an item first, so a Space, Home and every Automation see the same
event. Its adapter in `apps/server-ts/src/connections/items/` returns
`FetchedConnectionItem`s, and `runtime.ts` there saves them with the source's
cursor (`store.saveFetch`). The source is one entry in `SIGNAL_SOURCES`
(`libs/protocol/src/signals/index.ts`), its event in `ITEM_EVENT_TYPES` and a
`case` above, and a `feed` producer,
like GitHub: `{ eventType: "github.received", source: { kind: "feed" }, failureMessage: "GitHub item trigger failed" }`.
Fields the event offers beyond title, sender and snippet go in the item's
`detail`: `connections/items/calendar.ts` stores a calendar change that way and
its `case` publishes `calendar.changed` from it.

Only a source that is not an arrival keeps its own producer: a clock-based
event (`calendar.ts`, an event about to start) or a stream that exists only
while an Automation listens (`mcp-event.ts`, which calls
`triggers.readSourceCursor(ref)`, then `triggers.publishSourceEvents({ ...ref, events, cursor })`).

- No cursor yet: save the newest position, publish nothing, or old history fires (`0708669aa`).
- Arden's own write can cause it (a mail Arden sent): set `touches` (`39a4490ca`).

## 3. Register it

Import it in `apps/server-ts/src/automations/event-producers.ts` and add
`"email.received": emailItemEventProducer` to `producers`. Then
`apps/server-ts/src/automations/trigger-producers-runtime.ts` polls it, and
`apps/server-ts/src/persistence/sqlite/automation-event-dispatch.ts` queues runs.

## 4. Tell the run

Add a case to `describe` in `apps/server-ts/src/persistence/automations/event-text.ts`
and to `skippedEventOf` in `apps/server-ts/src/persistence/automations/event-words.ts`.
Email's case tells the run `connection_item_read(item_id=...)`. If a tool lists the
source's items, add the type to `sourceListing` in `event-text.ts` too.

- Every event names a read that opens what it is about (`f7f4b19ce`).

## Check

```bash
cd apps/server-ts && bun run typecheck && bunx vitest run test/automation-chain-depth.test.ts
```

It takes about 20 seconds and must end with:

```
 Test Files  1 passed (1)
```

What each failure means:

- `Property '"<type>"' is missing` in `triggers.ts` or `event-producers.ts`: step 1 or step 3.
- `Function lacks ending return statement` in `event-text.ts` or `event-words.ts`: step 4.
- `wakes the others once, never the producer`: dispatch itself broke, not your source.

No test runs a producer. A source that never publishes passes this check.
