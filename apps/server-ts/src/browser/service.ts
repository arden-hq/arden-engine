import type { BrowserScopeSnapshot } from "@arden-hq/protocol/browser-scope"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { ModelContentBlock } from "@arden-hq/loop"
import { Context, Effect, Layer, Schema } from "effect"

const BoundedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50_000))
export const TabRefSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
export const ProfileRefSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u))
const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const MAX_UPLOAD_FILES = 10

export const SitePermissionSchema = Schema.Literals(["camera", "microphone", "location"] as const)
export type SitePermission = typeof SitePermissionSchema.Type
export const SitePermissionRequestRefSchema = Schema.String.check(
  Schema.isPattern(/^permission-[a-f0-9]{1,64}$/u)
)

export const SiteSecretNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,47}$/u))

const BrowserTargetSchema = Schema.Struct({
  nodeRef: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u))),
  kind: Schema.optionalKey(
    Schema.Literals(["role", "text", "label", "placeholder", "alt", "title", "testid"] as const)
  ),
  value: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  exact: Schema.Boolean
})

const PointSchema = Schema.Struct({
  x: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1)),
  y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1))
})
const PointerFields = {
  type: Schema.Literal("pointer"),
  tabRef: TabRefSchema,
  profileRef: ProfileRefSchema,
  origin: BoundedString,
  screenshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
}
const BrowserOperationSchema = Schema.Union([
  Schema.Struct({ ...PointerFields, action: Schema.Literal("click"), point: PointSchema }),
  Schema.Struct({
    ...PointerFields,
    action: Schema.Literal("drag"),
    from: PointSchema,
    to: PointSchema
  }),
  Schema.Struct({ type: Schema.Literal("tabs") }),
  Schema.Struct({
    type: Schema.Literal("open"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    disposition: Schema.Literals(["current", "new"] as const),
    tabRef: Schema.optionalKey(TabRefSchema),
    profileRef: ProfileRefSchema
  }),
  Schema.Struct({ type: Schema.Literal("close"), tabRef: TabRefSchema }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    tabRef: TabRefSchema,
    mode: Schema.Literals(["interactive", "text"] as const),
    scope: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))
    ),
    depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
    maxChars: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 50_000 }))
  }),
  Schema.Struct({
    type: Schema.Literal("screenshot"),
    tabRef: TabRefSchema,
    annotated: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal("target"),
    tabRef: TabRefSchema,
    nodeRef: Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u))
  }),
  Schema.Struct({
    type: Schema.Literal("act"),
    tabRef: TabRefSchema,
    profileRef: ProfileRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    expectedRevision: RevisionSchema,
    action: Schema.Literals([
      "click",
      "dblclick",
      "hover",
      "focus",
      "fill",
      "type",
      "press",
      "select",
      "check",
      "uncheck",
      "scroll"
    ] as const),
    target: Schema.optionalKey(BrowserTargetSchema),
    value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
    secret: Schema.optionalKey(SiteSecretNameSchema),
    values: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(20_000))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(100)
      )
    ),
    direction: Schema.optionalKey(Schema.Literals(["up", "down", "left", "right"] as const)),
    amount: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })))
  }),
  Schema.Struct({
    type: Schema.Literal("upload"),
    tabRef: TabRefSchema,
    profileRef: ProfileRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    expectedRevision: RevisionSchema,
    nodeRef: Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u)),
    files: Schema.Array(
      Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(4_096))
    ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_UPLOAD_FILES))
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    tabRef: TabRefSchema,
    condition: Schema.Literals(["load", "url", "text", "element", "time"] as const),
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 }))
  }),
  Schema.Struct({
    type: Schema.Literal("permission"),
    tabRef: TabRefSchema,
    requestRef: SitePermissionRequestRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    permissions: Schema.Array(SitePermissionSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3)
    ),
    answer: Schema.Literals(["once", "always", "deny"] as const)
  }),
  Schema.Struct({
    type: Schema.Literal("site_secrets"),
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    tabRef: TabRefSchema,
    condition: Schema.Literal("download"),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 }))
  })
])

type BrowserOperation = (typeof BrowserOperationSchema)["Type"]

export const dispatchesPageChange = (operation: BrowserOperation): boolean =>
  operation.type === "act" || operation.type === "upload" || operation.type === "pointer"

const ModelContentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: BoundedString }),
  Schema.Struct({
    type: Schema.Literal("image"),
    media_type: Schema.Literal("image/png"),
    data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12_000_000))
  }),
  Schema.Struct({
    type: Schema.Literal("audio"),
    media_type: BoundedString,
    data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12_000_000))
  }),
  Schema.Struct({
    type: Schema.Literal("context"),
    content_type: BoundedString,
    content: Schema.optionalKey(Schema.NullOr(BoundedString)),
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
  })
])

export const BrowserOutputSchema = Schema.Struct({
  result: Schema.String.check(Schema.isMaxLength(50_000)),
  preview: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  modelContent: Schema.optionalKey(Schema.Array(ModelContentSchema).check(Schema.isMaxLength(4))),
  observation: Schema.optionalKey(
    Schema.Struct({
      tabRef: TabRefSchema,
      revision: RevisionSchema,
      targets: Schema.Record(
        Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u)),
        Schema.String.check(Schema.isMaxLength(600))
      )
    })
  )
})

export interface BrowserOutput extends Omit<typeof BrowserOutputSchema.Type, "modelContent"> {
  readonly modelContent?: ReadonlyArray<ModelContentBlock>
}

export const BrowserErrorCodeSchema = Schema.Literals([
  "browser_unavailable",
  "invalid_browser_request",
  "invalid_tab_ref",
  "browser_navigation_failed",
  "browser_snapshot_failed",
  "browser_screenshot_failed",
  "browser_snapshot_required",
  "stale_browser_snapshot",
  "stale_browser_scope",
  "browser_grant_mismatch",
  "browser_action_outcome_unknown",
  "browser_action_failed",
  "browser_wait_failed",
  "browser_cancelled",
  "browser_internal_error"
] as const)

export type BrowserErrorCode = typeof BrowserErrorCodeSchema.Type

export class BrowserClientError extends Error {
  readonly code: BrowserErrorCode
  readonly retryable: boolean
  readonly outcomeUnknown: boolean

  constructor(input: {
    readonly code: BrowserErrorCode
    readonly message: string
    readonly retryable: boolean
    readonly outcomeUnknown: boolean
  }) {
    super(input.message)
    this.name = "BrowserClientError"
    this.code = input.code
    this.retryable = input.retryable
    this.outcomeUnknown = input.outcomeUnknown
  }
}

export interface BrowserRequest {
  readonly sessionId: string
  readonly operation: BrowserOperation
}

export interface ScopedBrowserRequest extends BrowserRequest {
  readonly scope: BrowserScopeSnapshot
}

export interface BrowserBroker {
  readonly request: (request: ScopedBrowserRequest, signal: AbortSignal) => Promise<BrowserOutput>
}

export class BrowserClient extends Context.Service<
  BrowserClient,
  {
    readonly execute: (
      request: BrowserRequest,
      signal: AbortSignal
    ) => Effect.Effect<BrowserOutput, BrowserClientError>
  }
>()("@arden-hq/server/browser/BrowserClient") {
  static readonly layer = (
    broker?: BrowserBroker
  ): Layer.Layer<BrowserClient, never, SessionQueries> =>
    Layer.effect(
      BrowserClient,
      Effect.gen(function* () {
        const sessions = yield* SessionQueries
        const execute = Effect.fn("BrowserClient.execute")(
          function* (request: BrowserRequest, signal: AbortSignal) {
            if (broker === undefined)
              return yield* Effect.fail(
                new BrowserClientError({
                  code: "browser_unavailable",
                  message:
                    "The integrated browser needs Arden Desktop. Open Arden and let its window load, then check browser_tabs. Use web_fetch for public page text when sufficient.",
                  retryable: false,
                  outcomeUnknown: false
                })
              )
            const scope = yield* sessions
              .browserScope({ kind: "session", sessionId: request.sessionId })
              .pipe(
                Effect.mapError(
                  () =>
                    new BrowserClientError({
                      code: "browser_internal_error",
                      message: "Could not resolve this chat's browser",
                      retryable: true,
                      outcomeUnknown: false
                    })
                )
              )
            if (scope === undefined)
              return yield* Effect.fail(
                new BrowserClientError({
                  code: "invalid_browser_request",
                  message: "The browser's chat no longer exists",
                  retryable: false,
                  outcomeUnknown: false
                })
              )
            return yield* Effect.tryPromise({
              try: () => broker.request({ ...request, scope }, signal),
              catch: (cause) => {
                if (cause instanceof BrowserClientError) return cause
                const action = dispatchesPageChange(request.operation)
                return new BrowserClientError({
                  code: action ? "browser_action_outcome_unknown" : "browser_internal_error",
                  message: action
                    ? "Browser action failed without a confirmed outcome; inspect the page before another action"
                    : "Arden Desktop browser request failed",
                  retryable: !action,
                  outcomeUnknown: action
                })
              }
            })
          },
          Effect.retry({
            times: 1,
            while: (error: BrowserClientError) =>
              error.code === "stale_browser_scope" && !error.outcomeUnknown
          })
        )
        return BrowserClient.of({ execute })
      })
    )
}
