export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type JsonRecord = Readonly<Record<string, unknown>>
