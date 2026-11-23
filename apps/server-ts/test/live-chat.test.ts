import { DateTime } from "effect"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { expect, it } from "vitest"
import type { ChatRunnerMessage } from "../src/chat/runner-contract.js"
import { isLiveChat, type SessionOrigin } from "../src/context/turn-context.js"
import type { SessionHistoryHeader } from "../src/persistence/sessions/model.js"

const personal: SessionOrigin = {
  source: "personal",
  header: null,
  starting: undefined,
  special: undefined
}
const at = DateTime.makeUnsafe("2026-09-05T00:00:00.000Z")
const header: SessionHistoryHeader = {
  originJobPurpose: null,
  sessionId: "s1",
  publicRef: "chat~s1",
  startedAt: at,
  lastActivity: at,
  name: null,
  sessionType: "chat",
  originAutomationId: null,
  parentSessionId: null,
  parentRunId: null,
  parentToolCallId: null,
  parentMessageId: null,
  spaceId: null,
  spaceKind: null,
  spaceConversation: false,
  chatModel: null,
  activeMessageCount: 0,
  lastInputTokens: null,
  contextGeneration: 0
}
const agent: SessionOrigin = { source: "agent", mode: "work", header }
const fromApp: ChatRunnerMessage = { role: ROLE.user, content: "hi" }
const fromCommandLine: ChatRunnerMessage = { role: ROLE.user, content: "hi", sent_from: "cli" }

it("a chat keeps itself free for the next message only when a person is in it", () => {
  expect(isLiveChat(personal, [fromApp], true)).toBe(true)
  expect(isLiveChat(personal, [fromApp], false)).toBe(false)
  expect(isLiveChat(personal, [fromApp, fromCommandLine], true)).toBe(false)
  expect(isLiveChat(personal, [fromCommandLine, fromApp], true)).toBe(true)
  expect(isLiveChat(agent, [fromApp], true)).toBe(false)
})
