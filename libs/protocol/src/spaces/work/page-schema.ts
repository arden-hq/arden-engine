import { Schema } from "effect"
import { WORK_PAGE_MAX_LIMIT } from "./contracts.js"

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))

const pageLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(WORK_PAGE_MAX_LIMIT)
)
const pageCursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))

export const SpaceWorkPageOptionsSchema = Schema.Struct({
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literal("space"), space_id: NonEmptyStringSchema }),
    Schema.Struct({ kind: Schema.Literal("chat"), session_id: NonEmptyStringSchema }),
    Schema.Struct({
      kind: Schema.Literal("turn"),
      session_id: NonEmptyStringSchema,
      turn_id: NonEmptyStringSchema
    }),
    Schema.Struct({ kind: Schema.Literal("item"), item_id: NonEmptyStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  start: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("first") }),
    Schema.Struct({ kind: Schema.Literal("after"), cursor: pageCursor }),
    Schema.Struct({ kind: Schema.Literal("with_item"), item_id: NonEmptyStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  limit: pageLimit
})

const pageQueries = <Scope extends Schema.Struct.Fields>(scope: Scope) => {
  const limit = Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(WORK_PAGE_MAX_LIMIT)
  )
  return [
    Schema.Struct({ ...scope, limit, start: Schema.Literal("first") }),
    Schema.Struct({ ...scope, limit, start: Schema.Literal("after"), cursor: pageCursor }),
    Schema.Struct({
      ...scope,
      limit,
      start: Schema.Literal("with_item"),
      target_item_id: NonEmptyStringSchema
    })
  ] as const
}

export const SpaceWorkPageQuerySchema = Schema.Union([
  ...pageQueries({ scope: Schema.Literal("all") }),
  ...pageQueries({ scope: Schema.Literal("space"), space_id: NonEmptyStringSchema }),
  ...pageQueries({ scope: Schema.Literal("chat"), session_id: NonEmptyStringSchema }),
  ...pageQueries({
    scope: Schema.Literal("turn"),
    session_id: NonEmptyStringSchema,
    turn_id: NonEmptyStringSchema
  }),
  ...pageQueries({ scope: Schema.Literal("item"), item_id: NonEmptyStringSchema })
])
