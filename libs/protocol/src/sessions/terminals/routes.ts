import {
  appendSearch,
  encodeRouteEffect,
  encodeSegment,
  routeSegment
} from "../../common/routes.js"
import { Schema } from "effect"

const SessionIdSchema = routeSegment()
const TerminalRouteSchema = Schema.Struct({
  sessionId: routeSegment(),
  terminalId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

const terminalsPath = (sessionId: string): string =>
  `/sessions/${encodeSegment(sessionId)}/terminals`

const terminalPath = (route: { readonly sessionId: string; readonly terminalId: number }) =>
  `${terminalsPath(route.sessionId)}/${route.terminalId}`

export const encodeTerminalsPathEffect = (value: unknown) =>
  encodeRouteEffect(SessionIdSchema, value, terminalsPath)

export const encodeTerminalPathEffect = (value: unknown, suffix = "") =>
  encodeRouteEffect(TerminalRouteSchema, value, (route) => `${terminalPath(route)}${suffix}`)

export const encodeTerminalOutputPathEffect = (value: unknown, after: number) =>
  encodeRouteEffect(TerminalRouteSchema, value, (route) =>
    appendSearch(`${terminalPath(route)}/output`, [["after", after]])
  )
