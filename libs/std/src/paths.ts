import { homedir } from "node:os"
import path from "node:path"

const PARENT_SEGMENT = ".."

const HOME_MARK = "~"

export const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative.split(path.sep)[0] !== PARENT_SEGMENT && !path.isAbsolute(relative)
}

export const expandHome = (value: string, home: string = homedir()): string => {
  if (value === HOME_MARK) return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return value
}

export const collapseHome = (value: string, home: string = homedir()): string => {
  if (value === home) return HOME_MARK
  return isWithin(home, value) ? `~/${path.relative(home, value).split(path.sep).join("/")}` : value
}

export const ARDEN_DIR_VARIABLE = "ARDEN_DIR"

export const resolveArdenDir = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string => {
  const configured = environment[ARDEN_DIR_VARIABLE]?.trim() ?? ""
  return configured === "" ? path.join(home, ".arden") : path.resolve(expandHome(configured, home))
}

export const ardenCliDir = (home: string = homedir()): string => path.join(home, ".arden-cli")
