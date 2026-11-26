import { stat } from "node:fs/promises"

export const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
    throw cause
  }
}
