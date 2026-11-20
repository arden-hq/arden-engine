import { ROLE } from "@arden-hq/std/message-vocabulary"
import { expect, it } from "vitest"
import type { ChatRunnerMessage } from "../src/chat/runner-contract.js"
import { isLiveChat, type SessionOrigin } from "../src/context/turn-context.js"

const personal: SessionOrigin = {
  source: "personal",
  header: null,
  starting: undefined,
  special: undefined
}
const fromApp: ChatRunnerMessage = { role: ROLE.user, content: "hi" }
const fromCommandLine: ChatRunnerMessage = { role: ROLE.user, content: "hi", sent_from: "cli" }

it("a chat keeps itself free for the next message only when a person is in it", () => {
  // A person typing in the app.
  expect(isLiveChat(personal, [fromApp], true)).toBe(true)
  // The same chat on a server a program drives.
  expect(isLiveChat(personal, [fromApp], false)).toBe(false)
  // A turn asked for from the command line; the latest human message decides.
  expect(isLiveChat(personal, [fromApp, fromCommandLine], true)).toBe(false)
  expect(isLiveChat(personal, [fromCommandLine, fromApp], true)).toBe(true)
})
