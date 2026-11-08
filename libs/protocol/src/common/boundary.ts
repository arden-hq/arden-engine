import { Effect, Schema, type SchemaAST } from "effect"
import { ProtocolError, type ProtocolErrorKind } from "./errors.js"

/** Run one internal Effect program behind the package's plain error boundary. */
export const runBoundary = <A>(
  program: Effect.Effect<A, unknown>,
  message: string,
  kind: ProtocolErrorKind
): A => {
  try {
    return Effect.runSync(program)
  } catch {
    throw new ProtocolError(message, { kind })
  }
}

/** Parse option for boundaries that reject keys the schema does not name. */
export const strict = { onExcessProperty: "error" } as const

/**
 * Bind a schema to one ordinary `(unknown) => T` decoder. `T` is the
 * schema's decoded type, so a schema annotated `Schema.Codec<Interface>` (or a
 * type derived from the schema) is what the caller receives; there is no cast.
 */
export const decoderFor = <T>(
  schema: Schema.Decoder<T>,
  message: string,
  options?: SchemaAST.ParseOptions
): ((value: unknown) => T) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value) => runBoundary(decode(value, options), message, "decode")
}

/**
 * Like `decoderFor`, then map the decoded wire value into its public shape
 * (for example snake_case wire fields into a camelCase DTO). The projection's
 * own signature is the checked link between the two types.
 */
export const projectedDecoderFor = <T, A>(
  schema: Schema.Decoder<T>,
  project: (decoded: T) => A,
  message: string,
  options?: SchemaAST.ParseOptions
): ((value: unknown) => A) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value) => runBoundary(Effect.map(decode(value, options), project), message, "decode")
}

/** Bind one internal request serializer to a plain `(input) => string` API. */
export const makeEncoder =
  <A>(encode: (value: A) => Effect.Effect<string, unknown>, message: string) =>
  (value: A): string =>
    runBoundary(encode(value), message, "encode")

/** Normalize failures from one ordinary async iterable at the public boundary. */
export const asyncIterableBoundary = <A>(
  source: AsyncIterable<A>,
  message: string,
  kind: ProtocolErrorKind
): AsyncIterable<A> =>
  (async function* () {
    try {
      for await (const value of source) yield value
    } catch {
      throw new ProtocolError(message, { kind })
    }
  })()
