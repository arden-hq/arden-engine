import { describe, expect, it } from "vitest"

import { isWithin, resolveArdenDir } from "../src/paths.js"

describe("isWithin", () => {
  it.each([
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/b/c", true],
    ["/a/b", "/a/b/..cache", true],
    ["/a/b", "/a/b/..cache/x", true],
    ["/a/b", "/a/b/.../x", true],
    ["/a/b", "/a/bc", false],
    ["/a/b", "/a", false],
    ["/a/b", "/a/b/../c", false],
    ["/a/c", "/a/b/../c", true],
    ["/a/b", "/a/b/c/../../x", false]
  ])("root %s holds %s: %s", (root, target, inside) => {
    expect(isWithin(root, target)).toBe(inside)
  })
})

describe("resolveArdenDir", () => {
  it.each([
    [{}, "/home/p/.arden"],
    [{ ARDEN_DIR: "  " }, "/home/p/.arden"],
    [{ ARDEN_DIR: "~" }, "/home/p"],
    [{ ARDEN_DIR: "~/x" }, "/home/p/x"],
    [{ ARDEN_DIR: "/data/arden" }, "/data/arden"]
  ])("reads %o as %s", (environment, folder) => {
    expect(resolveArdenDir(environment, "/home/p")).toBe(folder)
  })
})
