import { ToolExecutionError } from "@arden-hq/loop"
import { expandHome } from "@arden-hq/std/paths"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { toolFault, toolRefusal } from "../tools/tool-failure.js"
import { collapseHome, isWithin } from "@arden-hq/std/paths"

const asDirectory = async (value: string): Promise<string> => {
  const expanded = expandHome(value)
  if (!path.isAbsolute(expanded)) {
    throw toolRefusal(
      "The Local folder must be an absolute path or start with '~'.",
      "Invalid Local folder"
    )
  }
  try {
    const resolved = await realpath(expanded)
    if (!(await stat(resolved)).isDirectory()) {
      throw toolRefusal(`${resolved} is not a directory.`, "Not a directory")
    }
    return resolved
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(`The Local folder is unavailable: ${expanded}.`, "Local folder unavailable")
  }
}

export const asPinnedDirectory = async (value: string): Promise<string> => {
  const expected = path.resolve(expandHome(value))
  const resolved = await asDirectory(value)
  if (resolved !== expected) {
    throw toolRefusal(
      `The pinned Local folder now resolves somewhere else: ${expected}.`,
      "Local folder changed"
    )
  }
  return resolved
}

export const realHome = (): string => {
  try {
    return realpathSync(homedir())
  } catch {
    return homedir()
  }
}

export const displayLocalPath = (target: string, cwd: string | null): string => {
  if (cwd === null) return collapseHome(target)
  const relative = path.relative(cwd, target)
  return relative.length > 0 && isWithin(cwd, target)
    ? relative.split(path.sep).join("/")
    : collapseHome(target)
}
