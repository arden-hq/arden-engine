export const SHELL_CHARACTER = {
  backslash: "\\",
  singleQuote: "'",
  doubleQuote: '"',
  backtick: "`",
  dollar: "$",
  hash: "#",
  input: "<",
  output: ">",
  open: "(",
  close: ")",
  openBrace: "{",
  closeBrace: "}",
  openBracket: "[",
  semicolon: ";",
  pipe: "|",
  ampersand: "&",
  newline: "\n",
  star: "*",
  question: "?",
  comma: ",",
  dot: ".",
  dash: "-",
  bang: "!",
  plus: "+",
  slash: "/"
} as const
export type ShellCharacter = (typeof SHELL_CHARACTER)[keyof typeof SHELL_CHARACTER]

export const isRedirect = (word: string): boolean =>
  word === SHELL_CHARACTER.input || word === SHELL_CHARACTER.output

export const isSubshellMark = (word: string): boolean =>
  word === SHELL_CHARACTER.open || word === SHELL_CHARACTER.close

export const SEGMENT_READING = { exact: "exact", loose: "loose" } as const
export type SegmentReading = (typeof SEGMENT_READING)[keyof typeof SEGMENT_READING]

export const SHELL_FRAME: ReadonlySet<string> = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  SHELL_CHARACTER.bang
])

export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"])

export const COMMAND = {
  awk: "awk",
  base64: "base64",
  cat: "cat",
  cd: "cd",
  cp: "cp",
  curl: "curl",
  date: "date",
  dd: "dd",
  diskutil: "diskutil",
  echo: "echo",
  env: "env",
  eval: "eval",
  find: "find",
  for: "for",
  gh: "gh",
  git: "git",
  ls: "ls",
  mv: "mv",
  popd: "popd",
  printf: "printf",
  pushd: "pushd",
  rsync: "rsync",
  sed: "sed",
  shred: "shred",
  sort: "sort",
  tee: "tee",
  timeout: "timeout",
  xargs: "xargs"
} as const
export type Command = (typeof COMMAND)[keyof typeof COMMAND]

export const OPTION = {
  end: "--",
  previousFolder: "-",
  ignoreEnvironment: "--ignore-environment",
  ignoreEnvironmentShort: "-i",
  list: "--list",
  listShort: "-l",
  method: "--method",
  methodShort: "-X",
  output: "--output",
  recursive: "--recursive",
  set: "--set",
  splitString: "--split-string",
  splitStringShort: "-S"
} as const
export type Option = (typeof OPTION)[keyof typeof OPTION]

export const NULL_DEVICE = "/dev/null"
