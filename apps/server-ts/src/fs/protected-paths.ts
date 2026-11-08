import { expandHome, isWithin } from "@arden-hq/std/paths"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const SECRET_HOME_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".config/gh",
  ".config/op",
  ".password-store",
  ".codex/auth.json",
  ".claude/.credentials.json",
  ".zsh_history",
  ".bash_history",
  ".local/share/fish/fish_history",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Application Support/Arden",
  ".config/Arden",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".mozilla",
  ".vault-token",
  ".terraform.d/credentials.tfrc.json",
  ".config/doppler",
  "Library/Group Containers/2BUA8C4S2C.com.1password",
  "Library/Group Containers/2BUA8C4S2C.com.agilebits"
] as const

export const PERSISTENCE_HOME_PATHS = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".config/fish",
  ".gitconfig",
  ".config/git",
  "Library/LaunchAgents",
  ".config/autostart",
  ".config/systemd/user"
] as const

const sensitiveHomePaths = (home: string): ReadonlyArray<string> =>
  [...SECRET_HOME_PATHS, ...PERSISTENCE_HOME_PATHS].map((relative) => path.join(home, relative))

export const tooWide = (
  folder: string,
  { stateRoots, home }: { readonly stateRoots: ReadonlyArray<string>; readonly home: string }
): boolean => {
  const guarded = [...stateRoots, ...sensitiveHomePaths(home)]
  const [top] = path.relative(home, folder).split(path.sep)
  const inHomeConfig =
    isWithin(home, folder) && top !== undefined && (top.startsWith(".") || top === "Library")
  return (
    inHomeConfig ||
    [home, ...guarded].some((inner) => isWithin(folder, inner)) ||
    guarded.some((root) => isWithin(root, folder))
  )
}

export const canonicalRulePath = async (raw: string): Promise<string | undefined> => {
  const expanded = expandHome(raw.trim(), homedir())
  if (!path.isAbsolute(expanded)) return undefined
  return realAncestor(path.resolve(expanded))
}

const realAncestor = async (resolved: string): Promise<string> => {
  const real = await realpath(resolved).catch(() => undefined)
  if (real !== undefined) return real
  const parent = path.dirname(resolved)
  return parent === resolved
    ? resolved
    : path.join(await realAncestor(parent), path.basename(resolved))
}
