import type { CommandKind, HttpMethod } from "@arden-hq/relay-protocol"
import { Option, Schema } from "effect"

const segment = "[^/]+"
const allowed: ReadonlyArray<{
  readonly method: "GET" | "POST"
  readonly pattern: RegExp
  readonly query: ReadonlySet<string>
}> = [
  { method: "GET", pattern: /^\/mobile\/home$/, query: new Set() },
  { method: "GET", pattern: /^\/mobile\/spaces$/, query: new Set() },
  {
    method: "GET",
    pattern: new RegExp(`^/mobile/sessions/${segment}/conversation$`),
    query: new Set(["before"])
  },
  { method: "POST", pattern: new RegExp(`^/spaces/${segment}/conversation$`), query: new Set() }
]

export type StreamRoute =
  | { readonly kind: "bus"; readonly path: string }
  | { readonly kind: "chat"; readonly path: string }

const normalize = (path: string): URL | undefined => {
  if (!path.startsWith("/") || path.startsWith("//")) return undefined
  try {
    const url = new URL(path, "http://relay.invalid")
    return url.host === "relay.invalid" && url.hash === "" ? url : undefined
  } catch {
    return undefined
  }
}

export const allowedRequest = (
  method: HttpMethod,
  path: string
): { readonly method: "GET" | "POST"; readonly path: string } | undefined => {
  const url = normalize(path)
  if (url === undefined) return undefined
  const route = allowed.find(
    (candidate) => candidate.method === method && candidate.pattern.test(url.pathname)
  )
  if (route === undefined) return undefined
  for (const key of url.searchParams.keys()) if (!route.query.has(key)) return undefined
  return { method: route.method, path: `${url.pathname}${url.search}` }
}

export const allowedStream = (path: string): StreamRoute | undefined => {
  const url = normalize(path)
  if (url === undefined || url.search !== "") return undefined
  if (url.pathname === "/automations/events") return { kind: "bus", path: url.pathname }
  return new RegExp(`^/chat/events/${segment}$`).test(url.pathname)
    ? { kind: "chat", path: url.pathname }
    : undefined
}

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Images = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      media_type: Schema.Literals(["image/png", "image/jpeg"]),
      data: Schema.String.check(Schema.isMinLength(1))
    })
  ).check(Schema.isMaxLength(4))
)
const Words = Schema.String.check(Schema.isMaxLength(100_000))

const CommandArgs = {
  send: Schema.Struct({
    session_id: Id,
    text: Words,
    images: Images,
    reply_to: Schema.optionalKey(
      Schema.Struct({
        message_id: Id,
        role: Schema.Literals(["user", "assistant"]),
        content: Schema.String.check(Schema.isMaxLength(100_000))
      })
    )
  }),
  answer: Schema.Struct({
    question_id: Id,
    text: Schema.String,
    option_id: Schema.optionalKey(Schema.NullOr(Id)),
    option_ids: Schema.optionalKey(
      Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(6))
    )
  }),
  decide: Schema.Struct({ run_id: Id, tool_id: Id, approve: Schema.Boolean }),
  stop: Schema.Struct({ session_id: Id }),
  capture: Schema.Struct({
    text: Words,
    space_id: Schema.optionalKey(Schema.NullOr(Id)),
    images: Images
  }),
  register_push: Schema.Struct({
    token: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64,200}$/)),
    environment: Schema.Literals(["sandbox", "production"]),
    topic: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,128}$/))
  }),
  set_keep_awake: Schema.Struct({ on: Schema.Boolean })
} satisfies Record<CommandKind, Schema.Decoder<unknown>>

export type Command = {
  readonly [K in CommandKind]: { readonly kind: K; readonly args: (typeof CommandArgs)[K]["Type"] }
}[CommandKind]

const decodeArgs = <S extends Schema.Decoder<unknown>>(
  schema: S,
  args: unknown
): S["Type"] | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(args, { onExcessProperty: "ignore" }))

export const decodeCommand = (kind: CommandKind, args: unknown): Command | undefined => {
  switch (kind) {
    case "send": {
      const decoded = decodeArgs(CommandArgs.send, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "answer": {
      const decoded = decodeArgs(CommandArgs.answer, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "decide": {
      const decoded = decodeArgs(CommandArgs.decide, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "stop": {
      const decoded = decodeArgs(CommandArgs.stop, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "capture": {
      const decoded = decodeArgs(CommandArgs.capture, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "register_push": {
      const decoded = decodeArgs(CommandArgs.register_push, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
    case "set_keep_awake": {
      const decoded = decodeArgs(CommandArgs.set_keep_awake, args)
      return decoded === undefined ? undefined : { kind, args: decoded }
    }
  }
}
