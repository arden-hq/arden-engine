import { Schema } from "effect"

export const StoreReason = Schema.Literals([
  "invalid",
  "not_found",
  "conflict",
  "corrupt",
  "unavailable",
  "storage"
] as const)

export type StoreReason = typeof StoreReason.Type

export const storeReasons = <const R extends ReadonlyArray<StoreReason>>(
  reasons: R
): Schema.Literals<R> => Schema.Literals(reasons)

export interface StoreErrorFields<
  O extends ReadonlyArray<string>,
  R extends ReadonlyArray<StoreReason>
> {
  readonly operation: Schema.Literals<O>
  readonly reason: Schema.Literals<R>
  readonly message: Schema.String
  readonly cause: Schema.optionalKey<Schema.Defect>
}

export const storeErrorFields = <
  const O extends ReadonlyArray<string>,
  const R extends ReadonlyArray<StoreReason>
>(options: {
  readonly operations: O
  readonly reasons: R
}): StoreErrorFields<O, R> => ({
  operation: Schema.Literals(options.operations),
  reason: storeReasons(options.reasons),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
})
