export const FIELD_WEIGHT = { title: 8, path: 5, body: 1 } as const

export const searchTerms = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length >= 2)
  )

interface ScoredField {
  readonly terms: ReadonlySet<string>
  readonly weight: number
}

export const lexicalScore = (
  fields: ReadonlyArray<ScoredField>,
  query: ReadonlySet<string>
): number => {
  let value = 0
  for (const term of query)
    for (const field of fields) if (field.terms.has(term)) value += field.weight
  return value
}
