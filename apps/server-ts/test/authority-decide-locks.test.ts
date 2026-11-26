import { describe, expect, it } from "vitest"
import { decide, type CallFacts, type LiveSettings } from "../src/execution/decide.js"
import { CONTAINED, INERT, OUTWARD } from "../src/execution/impact.js"
import { automation, call, live, person, tool, verdict, write } from "./authority-decide-kit.js"

describe("the locked list (plan, Appendix B decision 3)", () => {
  const act = tool("browser_act", { action: "write", refuse_unattended: true }, true)
  const password = (overrides: Partial<CallFacts> = {}) =>
    call(act, { impact: { kind: "locked", category: "passwords" }, ...overrides })
  const connector = tool("mcp__bank__transfer", { action: "write", default_approval: "ask" })

  it("asks the owner above every rule, mode and Helper; only a never or the floor refuses", () => {
    expect({
      "an allow rule, Auto": verdict(
        decide(person, live({ mode: "safe", rule: "allow" }), password())
      ),
      "Never ask": verdict(decide(person, live({ mode: "allow" }), password())),
      "its own card in Auto, not the owner's alone": verdict(
        decide(person, live({ mode: "safe" }), password({ requirement: true }))
      ),
      "a read in Read only": verdict(
        decide(
          person,
          live({ mode: "read_only" }),
          call(tool("read", { action: "read" }), {
            impact: { kind: "locked", category: "passwords" }
          })
        )
      ),
      "a write in Read only": verdict(decide(person, live({ mode: "read_only" }), password())),
      "unattended, can wait": verdict(
        decide(
          automation,
          live({ mode: "allow" }),
          call(write, { impact: { kind: "locked", category: "move_money" } })
        )
      ),
      "unattended, cannot wait": verdict(decide(automation, live({ mode: "safe" }), password())),
      "approved on its card": verdict(
        decide(person, live({ mode: "ask" }), password({ approved: true }))
      ),
      "a never rule": verdict(decide(person, live({ mode: "allow", rule: "never" }), password())),
      "a destructive command": verdict(
        decide(person, live({ mode: "allow" }), password({ floor: "destructive_command" }))
      ),
      "the same tool, no password": verdict(
        decide(person, live({ mode: "safe", rule: "allow" }), call(act))
      ),
      "a connector tool with no category, Never ask": verdict(
        decide(person, live({ mode: "allow" }), call(connector))
      ),
      "a connector tool with no category, Auto": verdict(
        decide(person, live({ mode: "safe" }), call(connector))
      )
    }).toEqual({
      "an allow rule, Auto": { ask: "locked", helper: false, delivery: "pause" },
      "Never ask": { ask: "locked", helper: false, delivery: "pause" },
      "its own card in Auto, not the owner's alone": {
        ask: "locked",
        helper: false,
        delivery: "pause"
      },
      "a read in Read only": { ask: "locked", helper: false, delivery: "pause" },
      "a write in Read only": { deny: "read_only", instead: ["ask_user"] },
      "unattended, can wait": { ask: "locked", helper: false, delivery: "chat" },
      "unattended, cannot wait": { ask: "locked", helper: false, delivery: "refuse" },
      "approved on its card": { allow: "user" },
      "a never rule": { deny: "user_deny", instead: ["ask_user"] },
      "a destructive command": { deny: "floor", instead: ["ask_user"] },
      "the same tool, no password": { allow: "grant" },
      "a connector tool with no category, Never ask": { allow: "mode" },
      "a connector tool with no category, Auto": { ask: "default", helper: true, delivery: "pause" }
    })
  })
})

describe("code settles a call by its impact; only an outward one reaches the reviewer", () => {
  const act = tool("browser_act", { action: "write", default_approval: "ask" })
  const at = (mode: LiveSettings["mode"], impact: CallFacts["impact"], overrides = {}) =>
    verdict(decide(person, live({ mode, ...overrides }), call(act, { impact })))

  it("decides each impact in each mode", () => {
    expect({
      "inert, Ask every time": at("ask", INERT),
      "inert, Auto": at("safe", INERT),
      "inert, Never ask": at("allow", INERT),
      "inert, Read only": at("read_only", INERT),
      "contained, Ask every time": at("ask", CONTAINED),
      "contained, Auto": at("safe", CONTAINED),
      "contained, Never ask": at("allow", CONTAINED),
      "outward, Ask every time": at("ask", OUTWARD),
      "outward, Auto": at("safe", OUTWARD),
      "outward, Never ask": at("allow", OUTWARD),
      "outward, Auto, an allow rule": at("safe", OUTWARD, { rule: "allow" })
    }).toEqual({
      "inert, Ask every time": { allow: "mode" },
      "inert, Auto": { allow: "mode" },
      "inert, Never ask": { allow: "mode" },
      "inert, Read only": { deny: "read_only", instead: ["ask_user"] },
      "contained, Ask every time": { ask: "default", helper: false, delivery: "pause" },
      "contained, Auto": { allow: "mode" },
      "contained, Never ask": { allow: "mode" },
      "outward, Ask every time": { ask: "default", helper: false, delivery: "pause" },
      "outward, Auto": { ask: "default", helper: true, delivery: "pause" },
      "outward, Never ask": { allow: "mode" },
      "outward, Auto, an allow rule": { allow: "grant" }
    })
  })
})
