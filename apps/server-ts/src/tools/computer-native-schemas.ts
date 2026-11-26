import { Schema } from "effect"
import { NativeTargetSchema } from "../computer/contract.js"

export const NATIVE_READ = { apps: "apps", windows: "windows", state: "state" } as const

export const ReadSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal(NATIVE_READ.apps).annotate({
      description:
        "apps lists installed and running apps. windows lists one app's windows (needs pid). state observes one window (needs target)."
    })
  }),
  Schema.Struct({
    operation: Schema.Literal(NATIVE_READ.windows).annotate({
      description:
        "apps lists installed and running apps. windows lists one app's windows (needs pid). state observes one window (needs target)."
    }),
    pid: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: "Process id of the app, from the apps operation. Used by windows."
    })
  }),
  Schema.Struct({
    operation: Schema.Literal(NATIVE_READ.state).annotate({
      description:
        "apps lists installed and running apps. windows lists one app's windows (needs pid). state observes one window (needs target)."
    }),
    target: NativeTargetSchema.annotate({
      description:
        "Exact pid and window_id of the window to observe, from the windows operation. Used by state."
    }),
    screenshot: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Return the window screenshot to you, scaled to at most 1,400 pixels, with element screenshot_frame boxes. Defaults to false. Use it before pixel_click or drag. Used by state."
      })
    ),
    accessibility: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Walk the accessibility tree and return elements with their tokens. Defaults to true. false skips the walk and requires screenshot=true. Used by state."
      })
    ),
    max_depth: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
        description: "Maximum accessibility-tree depth (1-25). Defaults to 12. Used by state."
      })
    ),
    timeout_ms: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10000 })).annotate({
        description:
          "Time budget for the accessibility walk in milliseconds (100-10,000). Defaults to 5,000. Used by state."
      })
    ),
    max_elements: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 2000 })).annotate({
        description: "Maximum elements to return (50-2,000). Defaults to 500. Used by state."
      })
    ),
    query: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(200)).annotate({
        description:
          "Case-insensitive substring, not a regex, that filters returned elements (up to 200 characters). Matches include their ancestors. It does not shorten the walk. Used by state."
      })
    )
  })
])
export const StateSchema = Schema.Struct({
  pid: Schema.Int,
  window_id: Schema.Int,
  app_name: Schema.optionalKey(Schema.String),
  window_title: Schema.optionalKey(Schema.String),
  snapshot_id: Schema.optionalKey(Schema.String),
  capture_id: Schema.optionalKey(Schema.String)
})
