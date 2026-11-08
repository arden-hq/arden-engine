import type {
  CompletionResponse,
  ModelProvider,
  ModelProviderRequest,
  ModelSource,
  ModelStreamItem
} from "../src/contracts/provider.js"

export interface Deferred<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
}

export const deferred = <A = void>(): Deferred<A> => {
  let resolve: (value: A) => void = () => undefined
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export const collect = async <A>(source: ModelSource<A>): Promise<Array<A>> => {
  const items: Array<A> = []
  for await (const item of await source) items.push(item)
  return items
}

export const completionOf = (items: ReadonlyArray<ModelStreamItem>): CompletionResponse => {
  const last = items.at(-1)
  if (last?._tag !== "Completed")
    throw new Error(`expected a completion last, got ${last?._tag ?? "nothing"}`)
  return last
}

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const recordOf = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("expected a JSON object")
  return value
}

export const recordsOf = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!Array.isArray(value)) throw new Error("expected a JSON array")
  return value.map(recordOf)
}

export const defined = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`expected ${what}`)
  return value
}

export const lastOf = <A>(items: ReadonlyArray<A>): A => defined(items.at(-1), "a non-empty list")

export const entryOf = <K, V>(map: ReadonlyMap<K, V>, key: K): V =>
  defined(map.get(key), `an entry for ${String(key)}`)

export const tagged = <E extends { readonly _tag: string }, T extends E["_tag"]>(
  items: ReadonlyArray<E>,
  tag: T
): Array<Extract<E, { readonly _tag: T }>> =>
  items.filter((item): item is Extract<E, { readonly _tag: T }> => item._tag === tag)

export const firstTagged = <E extends { readonly _tag: string }, T extends E["_tag"]>(
  items: ReadonlyArray<E>,
  tag: T
): Extract<E, { readonly _tag: T }> => defined(tagged(items, tag)[0], `a ${tag} item`)

export interface ScriptedProvider {
  readonly requests: Array<ModelProviderRequest>
  readonly shape: ModelProvider
}

export const scriptedProvider = (
  turns: ReadonlyArray<ReadonlyArray<ModelStreamItem>>,
  capabilities?: ModelProvider["capabilities"]
): ScriptedProvider => {
  const requests: Array<ModelProviderRequest> = []
  let index = 0
  return {
    requests,
    shape: {
      protocolVersion: 1,
      ...(capabilities === undefined ? {} : { capabilities }),
      stream: (request) => {
        requests.push(request)
        const turn = turns[index++]
        if (turn === undefined) throw new Error("test provider exhausted")
        return turn
      }
    }
  }
}
