import {
  appendSearch,
  encodeRouteEffect,
  encodeSegment,
  routeSegment
} from "../../common/routes.js"
import { Schema } from "effect"
import type { Effect } from "effect/Effect"

const SessionIdSchema = routeSegment()
const TerminalRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  terminalId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

const terminalsPath = (sessionId: string): string =>
  `/sessions/${encodeSegment(sessionId)}/terminals`

const terminalPath = (route: { readonly sessionId: string; readonly terminalId: number }) =>
  `${terminalsPath(route.sessionId)}/${route.terminalId}`

export const encodeTerminalsPathEffect = (
  value: unknown
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(SessionIdSchema, value, terminalsPath)

export const encodeTerminalPathEffect = (
  value: unknown,
  suffix = ""
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(TerminalRouteSchema, value, (route) => `${terminalPath(route)}${suffix}`)

export const encodeTerminalOutputPathEffect = (
  value: unknown,
  after: number
): Effect<string, Schema.SchemaError, never> =>
  encodeRouteEffect(TerminalRouteSchema, value, (route) =>
    appendSearch(`${terminalPath(route)}/output`, [["after", after]])
  )
