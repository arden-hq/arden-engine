import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras } from "../../common/schema.js"
import type {
  SessionTerminal,
  SessionTerminalsResponse,
  TerminalActionResponse,
  TerminalInputResponse,
  TerminalOutputResponse
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const

const SessionTerminalSchema: Schema.Codec<SessionTerminal> = withExtras({
  id: Schema.Int,
  tool_call_id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  access: Schema.Literals(["sandbox", "host"] as const),
  tty: Schema.Boolean,
  state: Schema.Literals(["running", "exited"] as const),
  exit_code: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  started_at: IsoDateTimeStringSchema,
  ended_at: Schema.NullOr(IsoDateTimeStringSchema),
  cursor: Schema.Int
})

export const SessionTerminalsResponseSchema: Schema.Codec<SessionTerminalsResponse> = withExtras({
  terminals: Schema.Array(SessionTerminalSchema)
})

export const TerminalOutputResponseSchema: Schema.Codec<TerminalOutputResponse> = withExtras({
  output: Schema.String,
  start: Schema.Int,
  cursor: Schema.Int
})

export const TerminalInputRequestSchema = Schema.Struct({
  chars: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
})

export const TerminalInputResponseSchema: Schema.Codec<TerminalInputResponse> = withExtras({
  status: Schema.Literals(["sent", "stdin_closed", "exited"] as const)
})

export const TerminalActionResponseSchema: Schema.Codec<TerminalActionResponse> = withExtras({
  ok: Schema.Literal(true)
})

export const encodeTerminalInputRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(TerminalInputRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
