import { expect, it } from "vitest"
import { shellAccess } from "../src/tools/shell-policy.js"

it("runs with the access the model asks for, and the chat's default otherwise", () => {
  expect(shellAccess(undefined, "sandbox", false)).toBe("sandbox")
  expect(shellAccess(true, "network", false)).toBe("network")
  expect(shellAccess(true, undefined, false)).toBe("host")
  expect(shellAccess(true, undefined, true)).toBe("sandbox")
  expect(shellAccess(true, "host", true)).toBe("host")
  expect(shellAccess(true, "network", true)).toBe("network")
})

it("runs every command on the host when the server has its sandbox off", () => {
  expect(shellAccess(false, "sandbox", false)).toBe("host")
  expect(shellAccess(false, "network", true)).toBe("host")
  expect(shellAccess(false, undefined, true)).toBe("host")
})
