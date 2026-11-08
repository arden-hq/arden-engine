import { homedir } from "node:os"
import path from "node:path"

/**
 * `target` is `root` itself or below it. Both are `path.resolve`d and compared
 * lexically: only a first segment that is exactly `..` leaves the root, so a
 * child folder named `..cache` stays inside. Symlinks are not followed; a
 * caller that must not be stepped around by one passes realpaths.
 */
export const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
}

/** `~` and `~/…` written the way a person writes a path, read against `home`. Nothing else changes. */
export const expandHome = (value: string, home: string = homedir()): string => {
  if (value === "~") return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return value
}

/** The exact inverse of `expandHome`: an absolute path written the way a
 *  person writes it. Only ever for display — `expandHome` reads it back. */
export const collapseHome = (value: string, home: string = homedir()): string => {
  if (value === home) return "~"
  return isWithin(home, value) ? `~/${path.relative(home, value).split(path.sep).join("/")}` : value
}

/** The environment variable that names Arden's data folder. */
export const ARDEN_DIR_VARIABLE = "ARDEN_DIR"

/**
 * Arden's data folder: `ARDEN_DIR` (blank means unset, `~` expanded, relative
 * resolved against the working directory), else `~/.arden`.
 */
export const resolveArdenDir = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string => {
  const configured = environment[ARDEN_DIR_VARIABLE]?.trim() ?? ""
  return configured === "" ? path.join(home, ".arden") : path.resolve(expandHome(configured, home))
}
