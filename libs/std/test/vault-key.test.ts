import { describe, expect, test } from "vitest"
import {
  addressCovers,
  fitsCard,
  onThisMachine,
  readAddresses,
  variableOf
} from "../src/vault-key.js"

describe("key rules", () => {
  test("a name gives the variable a command reads", () => {
    expect(
      ["Todoist", "GitHub token", "Open AI", "Ünïcode Ünit", "1Password", "Stripe key"].map(
        variableOf
      )
    ).toEqual([
      "TODOIST_API_KEY",
      "GITHUB_TOKEN",
      "OPEN_AI_API_KEY",
      "UNICODE_UNIT_API_KEY",
      "KEY_1PASSWORD_API_KEY",
      "STRIPE_KEY"
    ])
  })

  test("Send only to reads hosts, ports and addresses, and refuses the rest", () => {
    expect(
      readAddresses("api.todoist.com, https://Todoist.com/app localhost:11434 todoist.com")
    ).toEqual({
      kind: "ok",
      addresses: ["api.todoist.com", "todoist.com", "localhost:11434"]
    })
    expect(readAddresses("  ")).toEqual({ kind: "empty" })
    expect(readAddresses("ftp://files.example.com")).toEqual({
      kind: "refused",
      entry: "ftp://files.example.com"
    })
    expect(readAddresses("user@example.com")).toEqual({
      kind: "refused",
      entry: "user@example.com"
    })
    expect(readAddresses("example.com/?key=1")).toEqual({
      kind: "refused",
      entry: "example.com/?key=1"
    })
  })

  test("an address covers its exact host, https on 443, its own port, and plain http only on this machine", () => {
    const at = (host: string, port: number, secure: boolean) => ({ host, port, secure })
    expect(addressCovers("api.todoist.com", at("api.todoist.com", 443, true))).toBe(true)
    expect(addressCovers("api.todoist.com", at("API.todoist.com.", 443, true))).toBe(true)
    expect(addressCovers("todoist.com", at("api.todoist.com", 443, true))).toBe(false)
    expect(addressCovers("api.todoist.com", at("api.todoist.com", 80, false))).toBe(false)
    expect(addressCovers("api.todoist.com", at("api.todoist.com", 8443, true))).toBe(false)
    expect(addressCovers("example.com:8080", at("example.com", 8080, false))).toBe(false)
    expect(addressCovers("localhost:11434", at("localhost", 11434, false))).toBe(true)
    expect(addressCovers("localhost:11434", at("localhost", 11435, false))).toBe(false)
    expect(addressCovers("[::1]:8080", at("[::1]", 8080, false))).toBe(true)
  })
})

describe("an address on this machine", () => {
  test("is localhost, 127.0.0.1 or [::1], with or without a port", () => {
    expect(
      ["localhost:11434", "127.0.0.1", "[::1]:8080", "api.todoist.com", "10.0.0.2:80"].map(
        onThisMachine
      )
    ).toEqual([true, true, true, false, false])
  })
})

describe("the add-a-key card's limit", () => {
  test("is at most 3 addresses of at most 80 characters", () => {
    expect(fitsCard(["api.todoist.com", "todoist.com", "sync.todoist.com"])).toBe(true)
    expect(fitsCard(["a.com", "b.com", "c.com", "d.com"])).toBe(false)
    expect(fitsCard([`${"a".repeat(40)}.${"b".repeat(40)}.com`])).toBe(false)
    expect(fitsCard([])).toBe(false)
  })
})
