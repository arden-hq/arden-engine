import { escapeRegExp } from "@arden-hq/std/text"
import { basename, posix } from "node:path"
import { ASSIGNMENT, parseCommandSegments } from "./bash-permissions.js"

type Segment = ReadonlyArray<string>

interface CommandPlace {
  readonly home: string
  readonly cwd: string | undefined
}

const WRAPPER_DEPTH = 8

const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-U", "-C", "-D", "-h", "-p", "-r", "-t", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n"]),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  caffeinate: new Set(["-t", "-w"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set([
    "-I",
    "-i",
    "-n",
    "-P",
    "-L",
    "-l",
    "-d",
    "-E",
    "-e",
    "-s",
    "-a",
    "-J",
    "-R",
    "-S"
  ])
}

const SCRIPT_RUNNERS = new Set(["eval", "watch"])

const WATCH_VALUED = new Set(["-n", "--interval", "-d"])

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])

const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "{"])

const PARTITIONERS = new Set(["fdisk", "sfdisk", "gdisk"])

const DISKUTIL_ERASE = new Set([
  "erasedisk",
  "erasevolume",
  "partitiondisk",
  "reformat",
  "zerodisk",
  "randomdisk",
  "secureerase",
  "deletecontainer",
  "deletevolume"
])

const RECURSIVE_WRITERS: Readonly<Record<string, RegExp>> = {
  rm: /[rR]/,
  srm: /[rR]/,
  chmod: /R/,
  chown: /R/,
  chgrp: /R/
}

const FIND_FILTERS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-regex",
  "-iregex",
  "-newer",
  "-mtime",
  "-mmin",
  "-atime",
  "-amin",
  "-ctime",
  "-cmin",
  "-size",
  "-empty",
  "-user",
  "-group",
  "-perm",
  "-links",
  "-inum",
  "-samefile"
])

const NAME_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename"])

const EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

const WILDCARD = /^(?:\*|\?|\[[^\]]*\])+$/

const SYSTEM_FOLDERS = new Set([
  "/System",
  "/Users",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "/private/etc",
  "/private/var",
  "/Applications",
  "/Library",
  "/opt",
  "/Volumes",
  "/cores",
  "/dev",
  "/home",
  "/root",
  "/boot",
  "/lib",
  "/lib64"
])

const HARMLESS_DEVICES = /^\/dev\/(null|zero|random|urandom|stdout|stderr|stdin|tty|fd\/\d+)$/

const FORK_BOMB = /([^\s(){}|&;]+)\s*\(\s*\)\s*\{[^}]*?\1\s*\|\s*\1\s*&/

export const isDestructiveCommand = (command: string, place: CommandPlace): boolean =>
  destructive(command, place, 0)

const destructive = (command: string, place: CommandPlace, depth: number): boolean => {
  if (FORK_BOMB.test(command)) return true
  const segments = parseCommandSegments(command, { reading: "loose" })
  if (segments === undefined) return false
  let cwd = place.cwd
  const outer: Array<string | undefined> = []
  let previous: Segment = []
  for (const parsed of segments) {
    const segment = withoutKeywords(parsed)
    const name = basename(segment[0] ?? "")
    if (name === "(") outer.push(cwd)
    else if (name === ")") cwd = outer.length > 0 ? outer.pop() : cwd
    else if (name === "cd" || name === "pushd")
      cwd = changedDirectory(segment.slice(1), { home: place.home, cwd })
    else {
      if (destructiveSegment(segment, { home: place.home, cwd }, depth, fed(previous))) return true
      previous = segment
    }
  }
  return false
}

const withoutKeywords = (segment: Segment): Segment => {
  const start = segment.findIndex((word) => !KEYWORDS.has(word))
  return start === -1 ? [] : segment.slice(start)
}

const changedDirectory = (args: Segment, place: CommandPlace): string | undefined => {
  const target = args.find((arg) => arg === "-" || !arg.startsWith("-"))
  if (target === undefined) return place.home
  return target === "-" ? undefined : resolved(target, place)
}

const fed = (segment: Segment): Segment => {
  const name = basename(segment[0] ?? "")
  const args = segment.slice(1)
  if (name === "echo" || name === "printf") return words(args)
  if (name === "cat") return hereStrings(segment)
  if (name === "find") return findNarrows(args) ? [] : findStarts(args)
  if (name === "ls") return operands(args).map((folder) => `${folder}/*`)
  return []
}

const words = (args: Segment): Segment =>
  args.filter(
    (arg, index) => arg !== ">" && arg !== "<" && args[index - 1] !== ">" && args[index - 1] !== "<"
  )

const destructiveSegment = (
  segment: Segment,
  place: CommandPlace,
  depth: number,
  input: Segment
): boolean => {
  if (depth > WRAPPER_DEPTH) return true
  const executable = segment[0]
  if (executable === undefined) return false
  const name = basename(executable).toLowerCase()
  const args = segment.slice(1)
  if (writesDevice(segment)) return true
  if (name === "env") {
    const script = splitString(args)
    if (script !== undefined) return destructive(script, place, depth + 1)
  }
  const inner = wrapped(name, args)
  if (inner !== undefined) {
    if (name !== "xargs") return destructiveSegment(inner, place, depth + 1, input)
    const read = [...input, ...hereStrings(segment).flatMap((text) => text.split(/\s+/))]
    return destructiveSegment([...inner, ...read.filter(Boolean)], place, depth + 1, [])
  }
  if (SCRIPT_RUNNERS.has(name))
    return destructive(unwrap(args, WATCH_VALUED).join(" "), place, depth + 1)
  if (SHELLS.has(name)) {
    const script = shellScript(args) ?? readScript(segment, input)
    return script !== undefined && destructive(script, place, depth + 1)
  }
  const recursiveLetter = RECURSIVE_WRITERS[name]
  if (recursiveLetter !== undefined)
    return (
      recursive(args, recursiveLetter) &&
      operands(args).some((target) => protectedTree(target, place))
    )
  if (name === "find") return findDestroys(args, place)
  if (name === "mv")
    return operands(args)
      .slice(0, -1)
      .some((source) => protectedTree(source, place))
  if (name === "rsync")
    return (
      args.some((arg) => arg.startsWith("--delete")) &&
      protectedTree(operands(args).at(-1) ?? "", place)
    )
  if (name.startsWith("mkfs") || name.startsWith("newfs")) return true
  if (PARTITIONERS.has(name)) return !args.includes("-l") && !args.includes("--list")
  if (name === "diskutil") return args.some((arg) => DISKUTIL_ERASE.has(arg.toLowerCase()))
  if (name === "dd") return args.some((arg) => arg.startsWith("of=") && device(arg.slice(3)))
  if (name === "tee" || name === "shred") return operands(args).some(device)
  if (name === "cp") return device(operands(args).at(-1) ?? "")
  return false
}

const wrapped = (name: string, args: Segment): Segment | undefined => {
  const valued = WRAPPERS[name]
  if (valued === undefined) return undefined
  const inner = withoutKeywords(unwrap(args, valued))
  return name === "timeout" ? inner.slice(1) : inner
}

const readScript = (segment: Segment, input: Segment): string | undefined => {
  const here = hereStrings(segment)
  if (here.length > 0) return here.join("\n")
  return operands(segment.slice(1)).length === 0 && input.length > 0 ? input.join(" ") : undefined
}

const unwrap = (args: Segment, valued: ReadonlySet<string>): Segment => {
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ""
    if (arg === "--") return args.slice(index + 1)
    if (valued.has(arg)) index += 2
    else if (arg.startsWith("-") || ASSIGNMENT.test(arg)) index += 1
    else break
  }
  return args.slice(index)
}

const splitString = (args: Segment): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg === "-S" || arg === "--split-string") return args.slice(index + 1).join(" ")
    if (arg.startsWith("--split-string="))
      return [arg.slice(15), ...args.slice(index + 1)].join(" ")
    if (/^-S./.test(arg)) return [arg.slice(2), ...args.slice(index + 1)].join(" ")
    if (!arg.startsWith("-") && !ASSIGNMENT.test(arg)) return undefined
  }
  return undefined
}

const shellScript = (args: Segment): string | undefined => {
  const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
  if (flag === -1) return undefined
  return args[flag + 1] === "--" ? args[flag + 2] : args[flag + 1]
}

const hereStrings = (segment: Segment): Segment =>
  segment.flatMap((word, index) => (word === "<" ? [segment[index + 1] ?? ""] : []))

const options = (args: Segment): Segment => {
  const end = args.indexOf("--")
  return (end === -1 ? args : args.slice(0, end)).filter((arg) => arg.startsWith("-"))
}

const recursive = (args: Segment, letter: RegExp): boolean =>
  options(args).some(
    (arg) => arg === "--recursive" || (!arg.startsWith("--") && letter.test(arg.slice(1)))
  )

const operands = (args: Segment): Segment => {
  const found: string[] = []
  let literal = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === ">" || arg === "<") index += 1
    else if (!literal && arg === "--") literal = true
    else if (literal || !arg.startsWith("-")) found.push(arg)
  }
  return found
}

const findStarts = (args: Segment): Segment => {
  const end = args.findIndex((arg) => arg.startsWith("-") || arg === "(" || arg === "!")
  const starts = end === -1 ? args : args.slice(0, end)
  return starts.length === 0 ? ["."] : starts
}

const findNarrows = (args: Segment): boolean =>
  args.some(
    (arg, index) =>
      FIND_FILTERS.has(arg) && !(NAME_TESTS.has(arg) && WILDCARD.test(args[index + 1] ?? ""))
  )

const execRemoves = (args: Segment, index: number): boolean => {
  const end = args.findIndex((arg, at) => at > index && (arg === ";" || arg === "+"))
  let command = args.slice(index + 1, end === -1 ? undefined : end)
  for (let depth = 0; depth <= WRAPPER_DEPTH; depth += 1) {
    const name = basename(command[0] ?? "").toLowerCase()
    if (RECURSIVE_WRITERS[name] !== undefined) return true
    const inner = wrapped(name, command.slice(1))
    if (inner === undefined) return false
    command = [...inner]
  }
  return true
}

const findDestroys = (args: Segment, place: CommandPlace): boolean => {
  const deletes =
    args.includes("-delete") ||
    args.some((arg, index) => EXEC_ACTIONS.has(arg) && execRemoves(args, index))
  return (
    deletes && !findNarrows(args) && findStarts(args).some((start) => protectedTree(start, place))
  )
}

const writesDevice = (segment: Segment): boolean =>
  segment.some((word, index) => word === ">" && device(segment[index + 1] ?? ""))

const device = (path: string): boolean => path.startsWith("/dev/") && !HARMLESS_DEVICES.test(path)

const protectedTree = (target: string, place: CommandPlace): boolean =>
  braceAlternatives(target).some((word) => {
    const path = resolved(word, place)
    if (path === undefined) return false
    const home = trimmed(place.home)
    const tree = withoutWildcards(path)
    if (tree === "/" || tree === home || SYSTEM_FOLDERS.has(tree)) return true
    if (posix.dirname(tree) === "/Volumes") return true
    const last = posix.basename(tree)
    if (!/[*?[]/.test(last)) return false
    const parent = posix.dirname(tree)
    const pattern = globPattern(last)
    return [...SYSTEM_FOLDERS, home].some(
      (folder) => posix.dirname(folder) === parent && pattern.test(posix.basename(folder))
    )
  })

const globPattern = (glob: string): RegExp => {
  let source = ""
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? ""
    const close = character === "[" ? glob.indexOf("]", index + 2) : -1
    if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else if (close !== -1) {
      const set = glob
        .slice(index + 1, close)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\")
      source += `[${set}]`
      index = close
    } else source += escapeRegExp(character)
  }
  return new RegExp(`^${source}$`)
}

const resolved = (word: string, place: CommandPlace): string | undefined => {
  const expanded = withHome(word, place.home)
  if (/[$`]|^[<>]\(/.test(expanded)) return undefined
  if (expanded.startsWith("/")) return trimmed(posix.normalize(expanded))
  return place.cwd === undefined ? undefined : trimmed(posix.resolve(place.cwd, expanded))
}

const withHome = (word: string, home: string): string => {
  const own = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/
  if (own.test(word)) return word.replace(own, home)
  const user = /^~([A-Za-z0-9_.-]+)(?=\/|$)/.exec(word)
  if (user === null) return word
  return posix.join(posix.dirname(home), user[1] ?? "", word.slice(user[0].length))
}

const withoutWildcards = (path: string): string => {
  let tree = path
  while (tree !== "/" && WILDCARD.test(posix.basename(tree))) tree = posix.dirname(tree)
  return tree
}

const braceAlternatives = (word: string): ReadonlyArray<string> => {
  const group = /\{([^{}]*,[^{}]*)\}/.exec(word)
  if (group === null) return [word]
  const before = word.slice(0, group.index)
  const after = word.slice(group.index + group[0].length)
  return (group[1] ?? "")
    .split(",")
    .flatMap((part) => braceAlternatives(`${before}${part}${after}`))
    .slice(0, 64)
}

const trimmed = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
