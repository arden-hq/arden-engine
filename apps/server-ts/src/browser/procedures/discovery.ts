import { Effect, Schema } from "effect"
import type { BrowserOutput } from "../service.js"
import type { BrowserProcedures } from "./service.js"

const PageScope = Schema.Struct({
  origin: Schema.optionalKey(Schema.String),
  tab: Schema.Struct({ profile_ref: Schema.String, url: Schema.optionalKey(Schema.String) })
})

export const withBrowserProcedures = async (
  procedures: BrowserProcedures["Service"],
  value: BrowserOutput
): Promise<BrowserOutput> => {
  const scope = Schema.decodeUnknownOption(PageScope)(value.data)
  if (scope._tag === "None") return value
  const url = scope.value.tab.url
  const origin =
    scope.value.origin ?? (url !== undefined && URL.canParse(url) ? new URL(url).origin : undefined)
  if (origin === undefined || url === undefined) return value
  const available = await Effect.runPromise(
    procedures.discover(origin, scope.value.tab.profile_ref, url)
  ).catch(() => [])
  if (available.length === 0) return value
  return {
    ...value,
    result: `${value.result}\n\nSaved browser procedures available before acting: ${JSON.stringify(available)}. Use browser_procedure with this tab and this task's inputs when the entire task matches.`,
    data: {
      ...value.data,
      browser_procedures: available.map((p) => ({ ...p, inputs: p.inputs.map((f) => ({ ...f })) }))
    }
  }
}
