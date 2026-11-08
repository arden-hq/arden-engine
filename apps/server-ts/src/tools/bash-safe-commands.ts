import { basename } from "node:path"
import { textBefore } from "../lib/text.js"
import { ASSIGNMENT, hasShellExpansion, parseCommandSegments } from "./bash-permissions.js"
import { changesFolder, globsIntoFlag, hasGlob } from "./bash-globs.js"
import { sedReadsOnly } from "./bash-sed.js"

const READ_ONLY = new Set([
  "awk",
  "basename",
  "cat",
  "cut",
  "date",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "false",
  "fd",
  "file",
  "find",
  "grep",
  "head",
  "id",
  "jq",
  "less",
  "ls",
  "md5",
  "md5sum",
  "more",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sha1sum",
  "sha256sum",
  "shasum",
  "sort",
  "stat",
  "tail",
  "tr",
  "tree",
  "true",
  "type",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
  "yq"
])

const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    "blame",
    "branch",
    "describe",
    "diff",
    "log",
    "ls-files",
    "remote",
    "rev-parse",
    "show",
    "status"
  ]),
  gh: new Set(["issue", "pr", "repo", "run"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "why"]),
  pnpm: new Set(["ls", "list", "view", "info", "outdated", "why"]),
  yarn: new Set(["list", "info", "why"]),
  bun: new Set(["pm"]),
  cargo: new Set(["metadata", "tree"]),
  docker: new Set(["images", "inspect", "logs", "ps"]),
  kubectl: new Set(["describe", "get", "logs"])
}

const MUTATING_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  "git branch": new Set([
    "-d",
    "-D",
    "-m",
    "-M",
    "-f",
    "--delete",
    "--move",
    "--force",
    "--set-upstream-to",
    "-u",
    "--unset-upstream",
    "--edit-description"
  ]),
  "git remote": new Set([
    "add",
    "remove",
    "rm",
    "rename",
    "set-url",
    "set-head",
    "set-branches",
    "prune",
    "update"
  ]),
  "gh pr": new Set([
    "create",
    "merge",
    "close",
    "reopen",
    "edit",
    "review",
    "comment",
    "ready",
    "checkout",
    "lock",
    "unlock"
  ]),
  "gh issue": new Set([
    "create",
    "close",
    "reopen",
    "edit",
    "comment",
    "delete",
    "transfer",
    "pin",
    "unpin",
    "lock",
    "unlock",
    "develop"
  ]),
  "gh repo": new Set([
    "create",
    "delete",
    "edit",
    "fork",
    "clone",
    "rename",
    "archive",
    "unarchive",
    "sync",
    "set-default",
    "deploy-key"
  ]),
  "gh run": new Set(["cancel", "delete", "rerun", "download", "watch"]),
  "bun pm": new Set(["cache", "trust", "untrusted"])
}

const UNSAFE_FLAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  find: [
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls"
  ],
  fd: ["-x", "--exec", "-X", "--exec-batch"],
  rg: ["--pre", "--pre-glob"],
  grep: ["--pre"],
  awk: ["-f", "-i"],
  jq: ["--rawfile", "--slurpfile", "-f", "--from-file"],
  yq: ["-i", "--inplace"],
  sort: ["-o", "--output"],
  date: ["--set"],
  git: ["-c", "--exec-path", "-C"],
  gh: ["--exec"]
}

const flagName = (token: string): string =>
  token.startsWith("--") ? textBefore(token, "=") : token

const hasUnsafeFlag = (name: string, args: ReadonlyArray<string>): boolean => {
  const unsafe = UNSAFE_FLAGS[name]
  if (unsafe === undefined) return false
  return args.some((token) => {
    if (unsafe.includes(flagName(token))) return true
    // An attached output: sort -ofile.
    if (name === "sort" && /^-[a-zA-Z]*o/.test(token)) return true
    if (name === "date" && (/^-[a-zA-Z]*s/.test(token) || flagName(token) === "--set")) return true
    if (name === "git" && flagName(token) === "--output") return true
    return false
  })
}

const runsProgram = (name: string, args: ReadonlyArray<string>): boolean =>
  name === "awk" && args.some((token) => /system\s*\(|\|\s*"|>\s*"/.test(token))

const envReadsOnly = (args: ReadonlyArray<string>): boolean => {
  const command = args.findIndex(
    (arg) => arg !== "-i" && arg !== "--ignore-environment" && !ASSIGNMENT.test(arg)
  )
  if (command === -1) return true
  return !(args[command] ?? "").startsWith("-") && isReadOnlySegment(args.slice(command))
}

const isReadOnlySegment = (segment: ReadonlyArray<string>): boolean => {
  const executable = segment[0]
  if (executable === undefined) return false
  const name = basename(executable).toLowerCase()
  const args = segment.slice(1)
  if (name === "env") return envReadsOnly(args)
  if (name === "sed") return sedReadsOnly(args)
  if (hasUnsafeFlag(name, args)) return false
  if (runsProgram(name, args)) return false
  if (READ_ONLY.has(name)) return true
  const subcommands = READ_ONLY_SUBCOMMANDS[name]
  if (subcommands === undefined) return false
  const verb = args.find((token) => !token.startsWith("-"))
  if (verb === undefined || !subcommands.has(verb)) return false
  const mutating = MUTATING_VERBS[`${name} ${verb}`]
  if (mutating === undefined) return true
  const rest = args.slice(args.indexOf(verb) + 1)
  return !rest.some((token) => mutating.has(flagName(token)))
}

export const isReadOnlyCommand = (
  segments: ReadonlyArray<ReadonlyArray<string>> | undefined,
  cwd: string
): boolean =>
  segments !== undefined &&
  segments.length > 0 &&
  segments.every((segment) => isReadOnlySegment(segment) && !globsIntoFlag(segment, cwd))

const GH_NETWORK_READS: Readonly<Record<string, (rest: ReadonlyArray<string>) => boolean>> = {
  // A REST call is a GET unless a method says otherwise; fields make it a
  // POST unless the method is GET, where they are the query.
  api: (rest) => {
    const method = ghApiMethod(rest)
    if (method !== undefined) return method === "GET"
    return !rest.some((token) => /^-[fF]/.test(token) || /^--(field|raw-field|input)\b/.test(token))
  },
  auth: (rest) => rest.find((token) => !token.startsWith("-")) === "status",
  release: (rest) => ["list", "view"].includes(rest.find((token) => !token.startsWith("-")) ?? ""),
  search: () => true,
  status: () => true
}

/** The method a `gh api` call names last (gh reads the last one), if any:
 *  `-X POST`, `-XPOST`, `-X=POST`, `--method POST`, `--method=POST`. */
const ghApiMethod = (rest: ReadonlyArray<string>): string | undefined => {
  let method: string | undefined
  rest.forEach((token, index) => {
    if (token === "-X" || token === "--method") method = rest[index + 1]
    else if (token.startsWith("--method=")) method = token.slice("--method=".length)
    else if (/^-X./.test(token)) method = token.slice(2).replace(/^=/, "")
  })
  return method?.toUpperCase()
}

const CURL_READ_FLAGS = new Set([
  "--silent",
  "--show-error",
  "--location",
  "--fail",
  "--fail-with-body",
  "--include",
  "--head",
  "--insecure",
  "--compressed",
  "--get",
  "--globoff",
  "--http1.1",
  "--http2",
  "--no-progress-meter",
  "--verbose"
])
const CURL_READ_VALUE_FLAGS = new Set([
  "-H",
  "--header",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-m",
  "--max-time",
  "--connect-timeout",
  "--retry",
  "-w",
  "--write-out",
  "-u",
  "--user",
  "-b",
  "--cookie"
])
const CURL_READ_SHORT = /^-[sSLfiIkvG]+$/

const curlReadsOnly = (args: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ""
    if (!token.startsWith("-")) continue
    if (CURL_READ_FLAGS.has(token) || CURL_READ_SHORT.test(token)) continue
    if (CURL_READ_VALUE_FLAGS.has(flagName(token))) {
      if (!token.includes("=") && !/^-[HAemwub]./.test(token)) index += 1
      continue
    }
    if (/^-[HAemwub]./.test(token)) continue
    return false
  }
  return true
}

const isNetworkReadSegment = (name: string, args: ReadonlyArray<string>): boolean => {
  if (name === "curl") return curlReadsOnly(args)
  if (name !== "gh" || hasUnsafeFlag(name, args)) return false
  const at = args.findIndex((token) => !token.startsWith("-"))
  const read = at === -1 ? undefined : GH_NETWORK_READS[args[at] ?? ""]
  return read !== undefined && read(args.slice(at + 1))
}

export const SHELL_FRAME = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"])
const SHELL_ONLY = new Set(["done", "fi", "set", "cd", "export", "true", ":"])
const STDOUT_ONLY = new Set([
  "base64",
  "column",
  "comm",
  "expand",
  "fold",
  "nl",
  "od",
  "paste",
  "seq",
  "sleep",
  "test",
  "["
])

const changesNothingSegment = (segment: ReadonlyArray<string>): boolean => {
  let words = segment
  while (words[0] !== undefined && SHELL_FRAME.has(words[0])) words = words.slice(1)
  const [first] = words
  if (first === undefined || first === "(" || first === ")") return true
  if (words.some((token, index) => token.startsWith(">") && words[index + 1] !== "/dev/null"))
    return false
  const bare = words.filter(
    (token, index) => !(token.startsWith(">") || words[index - 1]?.startsWith(">"))
  )
  const name = basename(first).toLowerCase()
  if (name === "for") return bare.includes("in")
  if (SHELL_ONLY.has(first)) return true
  if (STDOUT_ONLY.has(name))
    return !(name === "base64" && bare.some((token) => /^(-o|--output)/.test(token)))
  return isReadOnlySegment(bare) || isNetworkReadSegment(name, bare.slice(1))
}

export const changesNothing = (command: string, cwd: string): boolean => {
  const exact = parseCommandSegments(command)
  if (exact !== undefined) return everyChangesNothing(exact, cwd)
  const segments = parseCommandSegments(command, { reading: "loose" })
  return segments !== undefined && everyChangesNothing(segments, cwd)
}

const everyChangesNothing = (
  segments: ReadonlyArray<ReadonlyArray<string>>,
  cwd: string
): boolean => {
  if (segments.length === 0) return false
  if (segments.some(changesFolder) && segments.some(hasGlob)) return false
  for (const segment of segments) {
    if (hasShellExpansion(segment)) return false
    if (globsIntoFlag(segment, cwd) || !changesNothingSegment(segment)) return false
  }
  return true
}
