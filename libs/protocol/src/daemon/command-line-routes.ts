export const COMMAND_LINE_RULE = {
  open: "open",
  plain_new_chat: "plain_new_chat",
  own_chat_in_path: "own_chat_in_path",
  own_run_in_path: "own_run_in_path",
  own_question_in_path: "own_question_in_path",
  own_chat_in_body: "own_chat_in_body",
  own_run_in_body: "own_run_in_body",
  own_run_or_chat_in_body: "own_run_or_chat_in_body"
} as const

export type CommandLineRule = (typeof COMMAND_LINE_RULE)[keyof typeof COMMAND_LINE_RULE]

export const COMMAND_LINE_METHOD = { get: "GET", post: "POST", delete: "DELETE" } as const

export type CommandLineMethod = (typeof COMMAND_LINE_METHOD)[keyof typeof COMMAND_LINE_METHOD]

export interface CommandLineRoute {
  readonly method: CommandLineMethod
  readonly path: string
  readonly rule: CommandLineRule
}

export const COMMAND_LINE_ROUTES: ReadonlyArray<CommandLineRoute> = [
  { method: COMMAND_LINE_METHOD.get, path: "/health", rule: COMMAND_LINE_RULE.open },
  { method: COMMAND_LINE_METHOD.get, path: "/spaces", rule: COMMAND_LINE_RULE.open },
  { method: COMMAND_LINE_METHOD.get, path: "/models", rule: COMMAND_LINE_RULE.open },
  { method: COMMAND_LINE_METHOD.get, path: "/tools", rule: COMMAND_LINE_RULE.open },
  { method: COMMAND_LINE_METHOD.get, path: "/sessions", rule: COMMAND_LINE_RULE.open },
  { method: COMMAND_LINE_METHOD.post, path: "/sessions", rule: COMMAND_LINE_RULE.plain_new_chat },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/sessions/:id/branch",
    rule: COMMAND_LINE_RULE.own_chat_in_path
  },
  {
    method: COMMAND_LINE_METHOD.delete,
    path: "/sessions/:id",
    rule: COMMAND_LINE_RULE.own_chat_in_path
  },
  {
    method: COMMAND_LINE_METHOD.delete,
    path: "/sessions/:id/permanent",
    rule: COMMAND_LINE_RULE.own_chat_in_path
  },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/chat/message",
    rule: COMMAND_LINE_RULE.own_chat_in_body
  },
  {
    method: COMMAND_LINE_METHOD.get,
    path: "/chat/events/:id",
    rule: COMMAND_LINE_RULE.own_chat_in_path
  },
  {
    method: COMMAND_LINE_METHOD.get,
    path: "/chat/runs/:id",
    rule: COMMAND_LINE_RULE.own_run_in_path
  },
  {
    method: COMMAND_LINE_METHOD.get,
    path: "/chat/runs/:id/events",
    rule: COMMAND_LINE_RULE.own_run_in_path
  },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/tools/result",
    rule: COMMAND_LINE_RULE.own_run_in_body
  },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/connections/result",
    rule: COMMAND_LINE_RULE.own_run_in_body
  },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/chat/questions/:id/answer",
    rule: COMMAND_LINE_RULE.own_question_in_path
  },
  {
    method: COMMAND_LINE_METHOD.post,
    path: "/cancel",
    rule: COMMAND_LINE_RULE.own_run_or_chat_in_body
  }
]

export interface CommandLineMatch {
  readonly route: CommandLineRoute
  readonly params: ReadonlyArray<string>
}

const patternOf = (path: string): RegExp => new RegExp(`^${path.replaceAll(":id", "([^/]+)")}$`)

const PATTERNS = COMMAND_LINE_ROUTES.map((route) => ({ route, pattern: patternOf(route.path) }))

export const commandLineRoute = (
  method: string,
  pathname: string
): CommandLineMatch | undefined => {
  for (const { route, pattern } of PATTERNS) {
    if (route.method !== method) continue
    const match = pattern.exec(pathname)
    if (match === null) continue
    return {
      route,
      params: match.slice(1).map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return ""
        }
      })
    }
  }
  return undefined
}
