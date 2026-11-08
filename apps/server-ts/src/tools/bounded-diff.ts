import { formatPatch, structuredPatch, type StructuredPatch, type StructuredPatchHunk } from "diff"

const MAX_DIFF_BYTES = 512 * 1024

export interface BoundedDiff {
  readonly patch: string
  readonly truncated: boolean
  readonly additions: number
  readonly deletions: number
}

const hunkLineCounts = (
  lines: ReadonlyArray<string>
): { readonly oldLines: number; readonly newLines: number } => ({
  oldLines: lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\")).length,
  newLines: lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\")).length
})

const partialHunk = (hunk: StructuredPatchHunk, lineCount: number): StructuredPatchHunk => {
  const lines = hunk.lines.slice(0, lineCount)
  return { ...hunk, ...hunkLineCounts(lines), lines }
}

const boundedStructuredPatch = (structured: StructuredPatch): string => {
  const included: StructuredPatchHunk[] = []
  for (const hunk of structured.hunks) {
    const candidate = formatPatch({ ...structured, hunks: [...included, hunk] })
    if (Buffer.byteLength(candidate, "utf8") <= MAX_DIFF_BYTES) {
      included.push(hunk)
      continue
    }
    if (included.length > 0) break

    let lower = 0
    let upper = hunk.lines.length
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2)
      const prefix = formatPatch({ ...structured, hunks: [partialHunk(hunk, middle)] })
      if (Buffer.byteLength(prefix, "utf8") <= MAX_DIFF_BYTES) lower = middle
      else upper = middle - 1
    }
    if (lower > 0) included.push(partialHunk(hunk, lower))
    break
  }
  return formatPatch({ ...structured, hunks: included })
}

export const DIFF_UNAVAILABLE =
  "Diff preview unavailable: the change exceeds the computation budget."

export const createBoundedDiff = (
  label: string,
  before: string,
  after: string
): BoundedDiff | undefined => {
  const structured = structuredPatch(label, label, before, after, "before", "after", {
    context: 3,
    maxEditLength: 2_000,
    timeout: 50
  })
  if (structured === undefined) return undefined
  const diff = formatPatch(structured)
  const additions = structured.hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith("+")).length,
    0
  )
  const deletions = structured.hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith("-")).length,
    0
  )
  const bytes = Buffer.byteLength(diff, "utf8")
  if (bytes <= MAX_DIFF_BYTES) return { patch: diff, truncated: false, additions, deletions }
  return {
    patch: boundedStructuredPatch(structured),
    truncated: true,
    additions,
    deletions
  }
}

export const boundedDiff = (label: string, before: string, after: string): string =>
  createBoundedDiff(label, before, after)?.patch ?? DIFF_UNAVAILABLE
