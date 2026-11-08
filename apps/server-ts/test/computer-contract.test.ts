import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  NativeObservations,
  NativeActionSchema,
  nativeDriverAction,
  nativeDelivery,
  requireForegroundWindow,
  type NativeAction
} from "../src/computer/contract.js"

const target = { pid: 20, window_id: 30 }
const action: NativeAction = {
  action: "click",
  target,
  observation: "o1",
  delivery: "background",
  element: "s00000001:5"
}

describe("native observation authorization", () => {
  it("binds to chat, window and snapshot, and consumes before uncertain execution", () => {
    const guard = new NativeObservations()
    guard.remember("o1", {
      app: undefined,
      window: undefined,
      elements: new Map(),
      owner: "chat",
      label: "Demo editor",
      target,
      visual: undefined,
      snapshot: "s00000001",
      capture: "c1"
    })
    expect(() => guard.consume("other", action)).toThrow()
    expect(() =>
      guard.consume("chat", { ...action, target: { ...target, window_id: 31 } })
    ).toThrow()
    guard.consume("chat", action)
    expect(() => guard.consume("chat", action)).toThrow()
  })

  it("invalidates previous observations and rejects tokens from another snapshot", () => {
    const guard = new NativeObservations()
    guard.remember("o1", {
      app: undefined,
      window: undefined,
      elements: new Map(),
      owner: "chat",
      label: "Demo editor",
      target,
      visual: undefined,
      snapshot: "s00000001",
      capture: undefined
    })
    guard.remember("o2", {
      app: undefined,
      window: undefined,
      elements: new Map(),
      owner: "chat",
      label: "Demo editor",
      target,
      visual: undefined,
      snapshot: "s00000002",
      capture: undefined
    })
    expect(() => guard.consume("chat", action)).toThrow()
    expect(() => guard.consume("chat", { ...action, observation: "o2" })).toThrow()
  })

  it("requires the exact capture and drops all authority on takeover", () => {
    const guard = new NativeObservations()
    const click: NativeAction = {
      action: "pixel_click",
      target,
      observation: "o1",
      delivery: "background",
      capture: "c2",
      x: 1,
      y: 2
    }
    const drag: NativeAction = {
      action: "drag",
      target,
      observation: "o1",
      delivery: "foreground",
      capture: "c2",
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4
    }
    for (const pointer of [click, drag]) {
      guard.remember("o1", {
        app: undefined,
        window: undefined,
        elements: new Map(),
        owner: "chat",
        label: "Demo editor",
        target,
        visual: undefined,
        snapshot: undefined,
        capture: "c1"
      })
      expect(() => guard.consume("chat", pointer)).toThrow()
    }
    guard.remember("o1", {
      app: undefined,
      window: undefined,
      elements: new Map(),
      owner: "chat",
      label: "Demo editor",
      target,
      visual: undefined,
      snapshot: undefined,
      capture: "c2"
    })
    guard.clear()
    expect(() => guard.consume("chat", click)).toThrow()
    expect(nativeDriverAction(click)).toEqual({
      name: "click",
      args: {
        ...target,
        delivery_mode: "background",
        capture_id: "c2",
        x: 1,
        y: 2,
        scope: "window"
      }
    })
  })
})

it("refuses foreground delivery to missing, off-Space or unverified windows", () => {
  const window = { ...target, on_current_space: true, is_on_screen: true }
  expect(() => requireForegroundWindow(target, { windows: [window] })).not.toThrow()
  expect(() =>
    requireForegroundWindow(target, {
      windows: [{ ...window, window_id: 31, on_current_space: null, is_on_screen: false }, window]
    })
  ).not.toThrow()
  for (const listing of [
    null,
    { windows: [] },
    { windows: [target] },
    { windows: [{ ...window, pid: 21 }] },
    { windows: [{ ...window, window_id: 31 }] },
    { windows: [{ ...window, on_current_space: false }] },
    { windows: [{ ...window, on_current_space: null }] },
    { windows: [{ ...window, is_on_screen: false }] }
  ]) {
    expect(() => requireForegroundWindow(target, listing)).toThrow()
  }
})

it("binds activation and focused keyboard input to one observed window", () => {
  const guard = new NativeObservations()
  const activation: NativeAction = {
    action: "activate",
    target,
    observation: "o1",
    delivery: "foreground"
  }
  guard.remember("o1", {
    app: undefined,
    window: undefined,
    elements: new Map(),
    owner: "chat",
    label: "Editor",
    target,
    visual: undefined,
    snapshot: undefined,
    capture: undefined
  })
  expect(() => guard.consume("other", activation)).toThrow()
  expect(() =>
    guard.consume("chat", { ...activation, target: { ...target, window_id: 31 } })
  ).toThrow()
  guard.consume("chat", activation)
  expect(() => guard.consume("chat", activation)).toThrow()
  expect(nativeDriverAction(activation)).toEqual({ name: "bring_to_front", args: target })
  const keyboard = Schema.decodeUnknownSync(NativeActionSchema)({
    action: "key",
    target,
    observation: "o2",
    delivery: "foreground",
    key: "g",
    modifiers: ["cmd", "shift"]
  })
  guard.remember("o2", {
    app: undefined,
    window: undefined,
    elements: new Map(),
    owner: "chat",
    label: "Native dialog",
    target,
    visual: undefined,
    snapshot: undefined,
    capture: "c2"
  })
  expect(() => guard.consume("other", keyboard)).toThrow()
  expect(() =>
    guard.consume("chat", { ...keyboard, target: { ...target, window_id: 31 } })
  ).toThrow()
  guard.consume("chat", keyboard)
  expect(() => guard.consume("chat", keyboard)).toThrow()
  expect(nativeDriverAction(keyboard)).toEqual({
    name: "press_key",
    args: { ...target, delivery_mode: "foreground", key: "g", modifiers: ["cmd", "shift"] }
  })
})

it("keeps semantic menus bound to the observed window and foreground delivery", () => {
  const menu: NativeAction = {
    action: "menu",
    target,
    observation: "o1",
    delivery: "foreground",
    path: ["File", "Save"]
  }
  const guard = new NativeObservations()
  guard.remember("o1", {
    app: undefined,
    window: undefined,
    elements: new Map(),
    owner: "chat",
    label: "Editor",
    target,
    visual: undefined,
    snapshot: "s00000001",
    capture: undefined
  })
  expect(Schema.is(NativeActionSchema)({ ...menu, delivery: "background" })).toBe(false)
  expect(Schema.is(NativeActionSchema)(menu)).toBe(true)
  guard.consume("chat", menu)
  expect(() => guard.consume("chat", menu)).toThrow()
  expect(nativeDriverAction(menu)).toEqual({
    name: "invoke_menu",
    args: { ...target, path: ["File", "Save"] }
  })
})
