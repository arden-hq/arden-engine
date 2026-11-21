import { expect, it } from "vitest"

import { decodeServerEvent, type RecordToldEvent } from "@arden-hq/protocol"
import {
  noticeOfEvent,
  notifyOwner,
  type NotificationLevel
} from "@arden-hq/protocol/notifications"

// Made-up records only; nothing is shown on a screen.

const told = (fields: Partial<RecordToldEvent> = {}): RecordToldEvent => ({
  type: "record_told",
  key: "ending:run-1",
  record: "ending",
  status: "finished",
  shown: true,
  unread: true,
  title: "Morning brief",
  text: "Sent the summary",
  chat_session_id: "chat-1",
  automation_id: "automation-1",
  item_id: null,
  ...fields
})

const levels: ReadonlyArray<NotificationLevel> = ["off", "needs_you", "everything"]

const notifiedAt = (event: RecordToldEvent, inFront = false) =>
  levels.filter((level) => notifyOwner({ record: noticeOfEvent(event), level, inFront }))

it("an alert the owner asked to be told notifies at the default level; other finished runs stay quiet there", () => {
  const alert = told({ key: "ending:run-2", title: "Urgent events", alert: true })
  expect(notifiedAt(alert)).toEqual(["needs_you", "everything"])
  // Off is off, and Arden in front shows it itself.
  expect(notifiedAt(alert, true)).toEqual([])
  // An alert already read in its chat is not news.
  expect(notifiedAt({ ...alert, unread: false })).toEqual([])
  // A run that finished without an alert, or from an engine that does not say, is news only to
  // "Everything".
  expect(notifiedAt(told())).toEqual(["everything"])
  expect(notifiedAt(told({ alert: false }))).toEqual(["everything"])
  // What waits on the owner is unchanged.
  expect(notifiedAt(told({ status: "failed" }))).toEqual(["needs_you", "everything"])
  expect(notifiedAt(told({ status: "silent", alert: true }))).toEqual([])
})

it("a record_told event keeps whether it is an alert", () => {
  const decoded = decodeServerEvent(told({ alert: true }))
  expect(decoded).toMatchObject({ type: "record_told", alert: true })
})
