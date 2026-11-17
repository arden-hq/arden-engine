import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Stands in for the desktop app's `arden-apple`: answers each "app verb" with
// the JSON it was given, or with a fault on stderr and exit 1, and records
// every argument list it got.
const SCRIPT = `
const { appendFileSync, readFileSync } = require("node:fs")
const { join } = require("node:path")
const args = process.argv.slice(2)
appendFileSync(join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n")
const answer = JSON.parse(readFileSync(join(__dirname, "answers.json"), "utf8"))[args.slice(0, 2).join(" ")]
if (answer === undefined || answer.fault !== undefined) {
  process.stderr.write(JSON.stringify(answer?.fault ?? { error: "usage", message: "No answer." }) + "\\n")
  process.exit(1)
}
if (answer.hangs === true) setTimeout(() => undefined, 60000)
else process.stdout.write((answer.raw ?? JSON.stringify(answer.prints)) + "\\n")
`

export type FakeMacAnswer =
  | { readonly prints: unknown }
  | { readonly fault: unknown }
  | { readonly raw: string }
  | { readonly hangs: true }

export interface FakeMacHelper {
  readonly directory: string
  readonly path: string
  readonly answer: (answers: Readonly<Record<string, FakeMacAnswer>>) => Promise<void>
  readonly calls: () => Promise<ReadonlyArray<ReadonlyArray<string>>>
  readonly forget: () => Promise<void>
  readonly remove: () => Promise<void>
}

export const makeFakeMacHelper = async (): Promise<FakeMacHelper> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-mac-apps-"))
  const path = join(directory, "arden-apple")
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "$0.cjs" "$@"\n`)
  await writeFile(`${path}.cjs`, SCRIPT)
  await chmod(path, 0o755)
  return {
    directory,
    path,
    answer: (answers) => writeFile(join(directory, "answers.json"), JSON.stringify(answers)),
    calls: async () =>
      (await readFile(join(directory, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): ReadonlyArray<string> => JSON.parse(line)),
    forget: () => rm(join(directory, "calls.jsonl"), { force: true }),
    remove: () => rm(directory, { recursive: true, force: true })
  }
}
