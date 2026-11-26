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
export const CardIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{24}$/u))
export const CardFillFieldSchema = Schema.Literals([
  "number",
  "expiry",
  "security_code",
  "name"
] as const)

export const BROWSER_TOOL = {
  tabs: "browser_tabs",
  open: "browser_open",
  close: "browser_close",
  snapshot: "browser_snapshot",
  screenshot: "browser_screenshot",
  act: "browser_act",
  wait: "browser_wait"
} as const
export type BrowserToolName = (typeof BROWSER_TOOL)[keyof typeof BROWSER_TOOL]

export const BROWSER_TARGET_KIND = {
  role: "role",
  text: "text",
  label: "label",
  placeholder: "placeholder",
  alt: "alt",
  title: "title",
  testid: "testid"
} as const
const BrowserTargetKindSchema = Schema.Literals(Object.values(BROWSER_TARGET_KIND))

const BrowserTargetSchema = Schema.Struct({
  nodeRef: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u))),
  kind: Schema.optionalKey(BrowserTargetKindSchema),
  value: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  exact: Schema.Boolean
})

const PointSchema = Schema.Struct({
  x: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1)),
  y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1))
})
export const BROWSER_OPERATION = {
  pointer: "pointer",
  tabs: "tabs",
  open: "open",
  close: "close",
  snapshot: "snapshot",
  screenshot: "screenshot",
  target: "target",
  act: "act",
  upload: "upload",
  wait: "wait",
  permission: "permission",
  site_secrets: "site_secrets",
  card_checkout: "card_checkout",
  card_frame: "card_frame"
} as const

export const BROWSER_POINTER_ACTION = { click: "click", drag: "drag" } as const

export const BROWSER_ACT_ACTION = {
  click: "click",
  dblclick: "dblclick",
  hover: "hover",
  focus: "focus",
  fill: "fill",
  type: "type",
  press: "press",
  select: "select",
  check: "check",
  uncheck: "uncheck",
  scroll: "scroll"
} as const

export const SITE_PERMISSION_ANSWER = { once: "once", always: "always", deny: "deny" } as const

const PointerFields = {
  type: Schema.Literal(BROWSER_OPERATION.pointer),
  tabRef: TabRefSchema,
  profileRef: ProfileRefSchema,
  origin: BoundedString,
  screenshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
}
const BrowserOperationSchema = Schema.Union([
  Schema.Struct({
    ...PointerFields,
    action: Schema.Literal(BROWSER_POINTER_ACTION.click),
    point: PointSchema
  }),
  Schema.Struct({
    ...PointerFields,
    action: Schema.Literal(BROWSER_POINTER_ACTION.drag),
    from: PointSchema,
    to: PointSchema
  }),
  Schema.Struct({ type: Schema.Literal(BROWSER_OPERATION.tabs) }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.open),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    disposition: Schema.Literals(["current", "new"] as const),
    tabRef: Schema.optionalKey(TabRefSchema),
    profileRef: ProfileRefSchema
  }),
  Schema.Struct({ type: Schema.Literal(BROWSER_OPERATION.close), tabRef: TabRefSchema }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.snapshot),
    tabRef: TabRefSchema,
    mode: Schema.Literals(["interactive", "text"] as const),
    scope: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))
    ),
    depth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
    maxChars: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 50_000 }))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.screenshot),
    tabRef: TabRefSchema,
    annotated: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.target),
    tabRef: TabRefSchema,
    nodeRef: Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.act),
    tabRef: TabRefSchema,
    profileRef: ProfileRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    expectedRevision: RevisionSchema,
    action: Schema.Literals(Object.values(BROWSER_ACT_ACTION)),
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
    type: Schema.Literal(BROWSER_OPERATION.upload),
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
    type: Schema.Literal(BROWSER_OPERATION.wait),
    tabRef: TabRefSchema,
    condition: Schema.Literals(["load", "url", "text", "element", "time"] as const),
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 }))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.permission),
    tabRef: TabRefSchema,
    requestRef: SitePermissionRequestRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    permissions: Schema.Array(SitePermissionSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3)
    ),
    answer: Schema.Literals(Object.values(SITE_PERMISSION_ANSWER))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.site_secrets),
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.card_checkout),
    tabRef: TabRefSchema,
    profileRef: ProfileRefSchema,
    origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    expectedRevision: RevisionSchema,
    card: CardIdSchema,
    fields: Schema.Array(
      Schema.Struct({
        nodeRef: Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u)),
        field: CardFillFieldSchema
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    payRef: Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.card_frame),
    tabRef: TabRefSchema,
    shop: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    frame: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
  }),
  Schema.Struct({
    type: Schema.Literal(BROWSER_OPERATION.wait),
    tabRef: TabRefSchema,
    condition: Schema.Literal("download"),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 }))
  })
])

type BrowserOperation = (typeof BrowserOperationSchema)["Type"]

const PAGE_CHANGING_OPERATIONS: ReadonlySet<BrowserOperation["type"]> = new Set([
  BROWSER_OPERATION.act,
  BROWSER_OPERATION.upload,
  BROWSER_OPERATION.pointer
])

export const dispatchesPageChange = (operation: BrowserOperation): boolean =>
  PAGE_CHANGING_OPERATIONS.has(operation.type)

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
