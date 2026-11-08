/** JSON-safe wire values. */
export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** An open string-keyed record: its values are not checked to be JSON. */
export type JsonRecord = Readonly<Record<string, unknown>>
