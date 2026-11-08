import { Effect, Schema } from "effect"

const strictRoute = { onExcessProperty: "error" } as const

/** Dot segments survive URI encoding and change the endpoint during URL normalization. */
export const nonRelativePathSegment = Schema.makeFilter((value: string) =>
  value === "." || value === ".." ? "must not be a relative path segment" : undefined
)

/** A bounded, already-trimmed identifier that is safe to encode as one path segment. */
export const routeSegment = (maximum = 512) =>
  Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), nonRelativePathSegment)

/** Decode semantic route input with Effect, then render it with web-platform URL APIs. */
export const encodeRouteEffect = <S extends Schema.Constraint>(
  schema: S,
  value: unknown,
  render: (decoded: S["Type"]) => string
) => Schema.decodeUnknownEffect(schema)(value, strictRoute).pipe(Effect.map(render))

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
