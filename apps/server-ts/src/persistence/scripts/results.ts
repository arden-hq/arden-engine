import { SETTLED_WORKFLOW_STATUSES } from "@arden-hq/protocol/workflows"
import { WorkflowSourceRefSchema } from "@arden-hq/protocol/effect/workflows"
import { Context, Schema, type Effect } from "effect"

export const MAX_SCRIPT_RESULT_ATTEMPTS = 20

const SettledStatusSchema = Schema.Literals(SETTLED_WORKFLOW_STATUSES)

export const ScriptResultPayloadSchema = Schema.Struct({
  kind: Schema.Literal("script_result"),
  sessionId: Schema.NonEmptyString,
  sessionRef: Schema.NonEmptyString,
  originRunId: Schema.NonEmptyString,
  workflowRef: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: SettledStatusSchema,
  preview: Schema.NullOr(Schema.String),
  sourceRefs: Schema.Array(WorkflowSourceRefSchema)
})
export type ScriptResultPayload = typeof ScriptResultPayloadSchema.Type

export interface ScriptResultDelivery {
  readonly deliveryId: string
  readonly body: string
  readonly payload: ScriptResultPayload
}

export type ScriptResultDeferral =
  | { readonly kind: "retrying"; readonly attempts: number; readonly nextAttemptAt: string }
  | { readonly kind: "abandoned"; readonly attempts: number }

export class ScriptResultError extends Schema.TaggedError<ScriptResultError>()(
  "ScriptResultError",
  {
    reason: Schema.Literals(["storage", "corrupt"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class ScriptResults extends Context.Service<
  ScriptResults,
  {
    readonly pending: (
      limit: number
    ) => Effect.Effect<ReadonlyArray<ScriptResultDelivery>, ScriptResultError>
    readonly admitted: (delivery: ScriptResultDelivery) => Effect.Effect<boolean, ScriptResultError>
    readonly markDelivered: (deliveryId: string) => Effect.Effect<void, ScriptResultError>
    readonly text: (script: {
      readonly workflowRef: string
      readonly attempt: number
    }) => Effect.Effect<string | undefined, ScriptResultError>
    readonly defer: (input: {
      readonly deliveryId: string
      readonly error: string
    }) => Effect.Effect<ScriptResultDeferral, ScriptResultError>
  }
>()("@arden-hq/server/persistence/scripts/ScriptResults") {}
