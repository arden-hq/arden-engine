import { Effect, Schema } from "effect"
import { strict } from "./boundary.js"

const RELATIVE_PATH_SEGMENT = { current: ".", parent: ".." } as const
type RelativePathSegment = (typeof RELATIVE_PATH_SEGMENT)[keyof typeof RELATIVE_PATH_SEGMENT]
const relativePathSegments: ReadonlySet<string> = new Set<RelativePathSegment>(
  Object.values(RELATIVE_PATH_SEGMENT)
)
export const isRelativePathSegment = (value: string): value is RelativePathSegment =>
  relativePathSegments.has(value)

export const nonRelativePathSegment = Schema.makeFilter((value: string) =>
  isRelativePathSegment(value) ? "must not be a relative path segment" : undefined
)

export const QUERY_BOOLEAN = { true: "true", false: "false" } as const

export type QueryBoolean = (typeof QUERY_BOOLEAN)[keyof typeof QUERY_BOOLEAN]

export const QueryBooleanTextSchema = Schema.Literals(Object.values(QUERY_BOOLEAN))

export const queryFlag = (value: boolean | QueryBoolean): boolean =>
  value === true || value === QUERY_BOOLEAN.true

export const routeSegment = (maximum = 512): Schema.Trimmed =>
  Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), nonRelativePathSegment)

export const encodeRouteEffect = <S extends Schema.Constraint>(
  schema: S,
  value: unknown,
  render: (decoded: S["Type"]) => string
): Effect.Effect<string, Schema.SchemaError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value, strict).pipe(Effect.map(render))

export const encodeSegment = (value: string): string => encodeURIComponent(value)

export const appendSearch = (
  path: string,
  entries: ReadonlyArray<readonly [string, string | number | boolean | undefined]>
): string => {
  const search = new URLSearchParams()
  for (const [name, value] of entries) {
    if (value !== undefined) search.append(name, String(value))
  }
  const encoded = search.toString()
  return encoded === "" ? path : `${path}?${encoded}`
}
