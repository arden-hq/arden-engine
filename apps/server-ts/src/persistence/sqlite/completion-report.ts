export interface CompletionReport {
  readonly result: string
  readonly evidence: ReadonlyArray<string>
  readonly gaps: ReadonlyArray<string>
}

export const completionReportText = (report: CompletionReport): string =>
  [
    report.result,
    ...section("Evidence", report.evidence),
    ...section("Still open", report.gaps)
  ].join("\n\n")

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0
    ? []
    : [`${heading}:\n${lines.map((line) => `- ${line.replace(/\n/g, "\n  ")}`).join("\n")}`]
