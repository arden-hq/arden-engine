import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const SRC = join(import.meta.dirname, "..", "src")

// Loops that are not jobs on the database: each needs a reason.
const ALLOWED: Readonly<Record<string, string>> = {
  "runtime/event-loop-monitor.ts": "measures event-loop delay; it must keep real time",
  "lib/timer-sleep.ts": "the helper itself"
}

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name))

// A job on a timer runs minutes or an hour after launch, so no test saw its
// queries and the scan check could not judge them (the hourly log trim read
// every chat). Timer loops wait through timerSleep, which the route sweep
// shortens; a loop that sleeps another way would hide from the check again.
it("every timer loop waits through timerSleep", () => {
  const offenders = sources(SRC)
    .filter((file) => {
      const text = readFileSync(file, "utf8")
      return /Effect\.forever|Effect\.repeat\(/.test(text) && /Effect\.sleep\(/.test(text)
    })
    .map((file) => relative(SRC, file))
    .filter((file) => ALLOWED[file] === undefined)
  expect(offenders).toEqual([])
})
