import { Effect, Schema, type SchemaAST } from "effect"
import { ProtocolError, type ProtocolErrorKind } from "./errors.js"

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

export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

export const decoderFor = <T>(
  schema: Schema.Decoder<T>,
  message: string,
  options?: SchemaAST.ParseOptions
): ((value: unknown) => T) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value) => runBoundary(decode(value, options), message, "decode")
}

export const projectedDecoderFor = <T, A>(
  schema: Schema.Decoder<T>,
  project: (decoded: T) => A,
  message: string,
  options?: SchemaAST.ParseOptions
): ((value: unknown) => A) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value) => runBoundary(Effect.map(decode(value, options), project), message, "decode")
}

export const makeEncoder =
  <A>(
    encode: (value: A) => Effect.Effect<string, unknown>,
    message: string
  ): ((value: A) => string) =>
  (value: A): string =>
    runBoundary(encode(value), message, "encode")

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
