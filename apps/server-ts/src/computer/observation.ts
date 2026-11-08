import { NativeAxActions } from "./contract.js"
import { Schema } from "effect"

const axActions = new Map<string, string>(Object.entries(NativeAxActions))
const isArray = Schema.is(Schema.Array(Schema.Json))
const isJson = Schema.is(Schema.Json)
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

export function nativeObservation(state: unknown, screenshot: boolean): Schema.Json {
  if (!isObject(state)) return isJson(state) ? state : null
  if (isArray(state.apps))
    return {
      ...state,
      apps: state.apps.map((app) =>
        isObject(app)
          ? Object.fromEntries(
              Object.entries(app).filter(
                ([key]) => !["last_used", "launch_path", "kind"].includes(key)
              )
            )
          : app
      )
    }
  if (!isArray(state.elements)) return state
  return {
    ...Object.fromEntries(
      Object.entries(state).filter(([key]) => !["tree_markdown", "_note"].includes(key))
    ),
    elements: state.elements.map((element) =>
      isObject(element)
        ? Object.fromEntries(
            Object.entries(element)
              .filter(([key]) => key !== "frame" && (screenshot || key !== "screenshot_frame"))
              .map(([key, value]) => [
                key,
                key === "actions" && isArray(value)
                  ? value.flatMap((action) => {
                      const supported =
                        typeof action === "string" ? axActions.get(action) : undefined
                      return supported === undefined ? [] : [supported]
                    })
                  : value
              ])
          )
        : element
    )
  }
}
