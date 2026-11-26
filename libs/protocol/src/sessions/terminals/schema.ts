import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras } from "../../common/schema.js"
import {
  TERMINAL_STATE,
  type SessionTerminal,
  type SessionTerminalsResponse,
  type TerminalActionResponse,
  type TerminalInputResponse,
  type TerminalOutputResponse
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const

const terminalFields = {
  id: Schema.Int,
  tool_call_id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  access: Schema.Literals(["sandbox", "network", "host"] as const),
  tty: Schema.Boolean,
  started_at: IsoDateTimeStringSchema,
  cursor: Schema.Int
}

const SessionTerminalSchema: Schema.Codec<SessionTerminal> = Schema.Union([
  withExtras({ ...terminalFields, state: Schema.Literal(TERMINAL_STATE.running) }),
  withExtras({
    ...terminalFields,
    state: Schema.Literal(TERMINAL_STATE.exited),
    exit: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("code"), code: Schema.Int }),
      Schema.Struct({ kind: Schema.Literal("signal"), signal: Schema.String })
    ]),
    ended_at: IsoDateTimeStringSchema
  })
])

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

export const encodeTerminalInputRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(TerminalInputRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
