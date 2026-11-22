export type CommandLineRule =
  | "open"
  | "plain_new_chat"
  | "own_chat_in_path"
  | "own_run_in_path"
  | "own_question_in_path"
  | "own_chat_in_body"
  | "own_run_in_body"
  | "own_run_or_chat_in_body"

export interface CommandLineRoute {
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: string
  readonly rule: CommandLineRule
}

export const COMMAND_LINE_ROUTES: ReadonlyArray<CommandLineRoute> = [
  { method: "GET", path: "/health", rule: "open" },
  { method: "GET", path: "/spaces", rule: "open" },
  { method: "GET", path: "/models", rule: "open" },
  { method: "GET", path: "/tools", rule: "open" },
  { method: "GET", path: "/sessions", rule: "open" },
  { method: "POST", path: "/sessions", rule: "plain_new_chat" },
  { method: "POST", path: "/sessions/:id/branch", rule: "own_chat_in_path" },
  { method: "DELETE", path: "/sessions/:id", rule: "own_chat_in_path" },
  { method: "DELETE", path: "/sessions/:id/permanent", rule: "own_chat_in_path" },
  { method: "POST", path: "/chat/message", rule: "own_chat_in_body" },
  { method: "GET", path: "/chat/events/:id", rule: "own_chat_in_path" },
  { method: "GET", path: "/chat/runs/:id", rule: "own_run_in_path" },
  { method: "GET", path: "/chat/runs/:id/events", rule: "own_run_in_path" },
  { method: "POST", path: "/tools/result", rule: "own_run_in_body" },
  { method: "POST", path: "/connections/result", rule: "own_run_in_body" },
  { method: "POST", path: "/chat/questions/:id/answer", rule: "own_question_in_path" },
  { method: "POST", path: "/cancel", rule: "own_run_or_chat_in_body" }
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
