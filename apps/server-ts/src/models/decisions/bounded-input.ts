import { lexicalScore, searchTerms } from "../../memory/lexical-score.js"

export interface BoundedList<T> {
  readonly shown: ReadonlyArray<T>
  readonly omitted: number
}

export const bounded = <T>(entries: ReadonlyArray<T>, limit: number): BoundedList<T> => ({
  shown: entries.slice(0, limit),
  omitted: Math.max(0, entries.length - limit)
})

interface Candidate {
  readonly fields: ReadonlyArray<{ readonly text: string; readonly weight: number }>
  readonly at: string
  readonly size: number
  readonly anchor: boolean
}

export const relevantFirst = <T>(
  units: ReadonlyArray<T>,
  options: {
    readonly query: string
    readonly budget: number
    readonly candidate: (unit: T) => Candidate
  }
): BoundedList<T> => {
  const query = searchTerms(options.query)
  const ranked = units
    .map((unit, index) => {
      const candidate = options.candidate(unit)
      const score = lexicalScore(
        candidate.fields.map((field) => ({ terms: searchTerms(field.text), weight: field.weight })),
        query
      )
      return { unit, index, candidate, score }
    })
    .toSorted(
      (a, b) =>
        Number(b.candidate.anchor) - Number(a.candidate.anchor) ||
        (a.candidate.anchor ? 0 : b.score - a.score) ||
        b.candidate.at.localeCompare(a.candidate.at) ||
        a.index - b.index
    )
  const shown: Array<(typeof ranked)[number]> = []
  let used = 0
  for (const entry of ranked) {
    if (used + entry.candidate.size > options.budget) continue
    shown.push(entry)
    used += entry.candidate.size
  }
  return {
    shown: shown
      .toSorted((a, b) => a.candidate.at.localeCompare(b.candidate.at) || a.index - b.index)
      .map((entry) => entry.unit),
    omitted: units.length - shown.length
  }
}

export const omittedLine = (omitted: number, what: string): ReadonlyArray<string> =>
  omitted === 0 ? [] : [`- (${omitted} more ${what} not shown)`]
