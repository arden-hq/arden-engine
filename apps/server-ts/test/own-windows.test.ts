import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { windowCall } from "../src/computer/own-windows.js"

const ARDEN = 100
const NOTES = 200

function fakeDriver(
  answer: (args: Readonly<Record<string, Schema.Json>>) => Record<string, Schema.Json>
) {
  const calls: string[] = []
  const send = async (
    name: string,
    args: Readonly<Record<string, Schema.Json>>
  ): Promise<CallToolResult> => {
    calls.push(name)
    if (name === "list_windows") {
      const owned: Record<number, number> = { [ARDEN]: 7, [NOTES]: 9 }
      const pid = Number(args.pid)
      const windows = owned[pid] === undefined ? [] : [{ pid, window_id: owned[pid] }]
      return { content: [], structuredContent: { windows } }
    }
    return {
      content: [{ type: "text", text: "the window's text" }],
      structuredContent: answer(args)
    }
  }
  return { send, calls }
}

const asked = (args: Readonly<Record<string, Schema.Json>>) => ({
  pid: args.pid ?? null,
  window_id: args.window_id ?? null
})

const name = "get_window_state"

describe("driver calls that name a window", () => {
  it(`${name}: another app's pid with Arden's window id is refused before the driver is asked`, async () => {
    const driver = fakeDriver(asked)
    const result = await windowCall(name, { pid: NOTES, window_id: 7 }, ARDEN, driver.send)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("Arden's own window")
    expect(driver.calls).not.toContain(name)
  })

  it(`${name}: a window the driver does not list for that pid is refused`, async () => {
    const driver = fakeDriver(asked)
    const result = await windowCall(name, { pid: NOTES, window_id: 55 }, ARDEN, driver.send)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("not one of that app's windows")
    expect(driver.calls).not.toContain(name)
  })

  it(`${name}: an answer naming another pid or window than asked is an error with no content of it`, async () => {
    for (const other of [
      { pid: ARDEN, window_id: 9 },
      { pid: NOTES, window_id: 7 }
    ]) {
      const driver = fakeDriver(() => other)
      const result = await windowCall(name, { pid: NOTES, window_id: 9 }, ARDEN, driver.send)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain("the window's text")
      expect(result.structuredContent).toBeUndefined()
    }
  })

  it(`${name}: the app's own window goes through with the driver's answer intact`, async () => {
    const driver = fakeDriver(asked)
    const result = await windowCall(name, { pid: NOTES, window_id: 9 }, ARDEN, driver.send)
    expect(result.isError).toBeUndefined()
    expect(driver.calls).toContain(name)
    expect(result.content).toEqual([{ type: "text", text: "the window's text" }])
    expect(result.structuredContent).toEqual({ pid: NOTES, window_id: 9 })
  })

  it("a call that names no window is passed as it is", async () => {
    const driver = fakeDriver(() => ({ apps: [] }))
    await windowCall("list_apps", {}, ARDEN, driver.send)
    expect(driver.calls).toEqual(["list_apps"])
  })
})
