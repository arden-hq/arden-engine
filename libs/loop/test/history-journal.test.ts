import { expect, it } from "vitest"
import { makeHistoryJournal } from "../src/agent/history-journal.js"

it("checkpoints appended history, invalidates the cursor on replacement, and retries a failed write", async () => {
  const history = makeHistoryJournal([{ message_id: "first", role: "user", content: "Start" }])
  const changes: Array<{ readonly kind: string; readonly start?: number; readonly ids: string[] }> =
    []
  const record = (change: Parameters<Parameters<typeof history.checkpoint>[0]>[1]) => {
    changes.push({
      kind: change.kind,
      ...(change.kind === "append" ? { start: change.start } : {}),
      ids: change.messages.map((message) => message.message_id ?? "")
    })
  }
  await history.checkpoint(async (_messages, change) => record(change))
  const source = { message_id: "second", role: "assistant" as const, content: "Working" }
  history.messages.push(source)
  source.content = "Caller changed its own object"
  expect(history.messages[1]?.content).toBe("Working")
  await expect(
    history.checkpoint(async (_messages, change) => {
      record(change)
      throw new Error("write failed")
    })
  ).rejects.toThrow("write failed")
  await history.checkpoint(async (_messages, change) => record(change))
  history.messages[0] = { message_id: "first", role: "user", content: "Replaced" }
  await history.checkpoint(async (_messages, change) => record(change))

  expect(changes).toEqual([
    { kind: "replace", ids: ["first"] },
    { kind: "append", start: 1, ids: ["second"] },
    { kind: "append", start: 1, ids: ["second"] },
    { kind: "replace", ids: ["first", "second"] }
  ])
  expect(() => {
    const first = history.messages[0]
    if (first === undefined) throw new Error("Expected a first message")
    Object.assign(first, { content: "Mutated" })
  }).toThrow()
})

it("serializes checkpoint acknowledgements while later appends remain available", async () => {
  const history = makeHistoryJournal([{ message_id: "first", role: "user", content: "Start" }])
  let release = () => {}
  const first = history.checkpoint(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  history.messages.push({ message_id: "second", role: "assistant", content: "Working" })
  const seen: string[] = []
  const second = history.checkpoint(async (_messages, change) => {
    seen.push(`${change.kind}:${change.messages.map((message) => message.message_id).join(",")}`)
  })
  release()
  await Promise.all([first, second])
  expect(seen).toEqual(["append:second"])
})
