import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"

export const locateExecutable = async (
  command: string,
  path: string
): Promise<string | undefined> => {
  if (command.includes("/")) {
    return isAbsolute(command) && (await isExecutableFile(command)) ? command : undefined
  }
  for (const folder of path.split(delimiter).filter((entry) => isAbsolute(entry))) {
    const candidate = join(folder, command)
    if (await isExecutableFile(candidate)) return candidate
  }
  return undefined
}

const isExecutableFile = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK)
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}
