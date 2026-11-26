import type { ElementNode } from "@openuidev/lang-core"
import { isAstNode, isElement } from "./ast.js"
import { FORMULA_READ_KIND, missingVariables, readFormula } from "./formula.js"
import { COMPONENT_NAME } from "./parts.js"
import { isRecord } from "@arden-hq/std/json"

interface FormulaIssue {
  readonly statementId: string | undefined
  readonly message: string
}

export function formulaIssues(root: ElementNode | null): ReadonlyArray<FormulaIssue> {
  const issues: FormulaIssue[] = []
  const visit = (value: unknown, statementId: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, statementId)
      return
    }
    if (!isElement(value)) return
    const at = value.statementId ?? statementId
    const report = (message: string) => issues.push({ statementId: at, message })
    switch (value.typeName) {
      case COMPONENT_NAME.Formula: {
        const label = typeof value.props["label"] === "string" ? value.props["label"] : "Formula"
        const problem = formulaProblem(value.props["fn"], value.props["vars"], [])
        if (problem !== undefined) report(`Formula "${label}": ${problem}`)
        return
      }
      case COMPONENT_NAME.Plot: {
        const spec = value.props["spec"]
        if (!isRecord(spec)) return
        const x = spec["x"]
        if (isRecord(x) && typeof x["from"] === "number" && typeof x["to"] === "number")
          if (!(x["to"] > x["from"])) report("Plot: x.to must be larger than x.from.")
        const series = spec["series"]
        if (!Array.isArray(series)) return
        series.forEach((line, index) => {
          if (!isRecord(line)) return
          const name = typeof line["name"] === "string" ? line["name"] : `series ${index + 1}`
          const problem = formulaProblem(line["fn"], line["vars"], ["x"])
          if (problem !== undefined) report(`Plot series "${name}": ${problem}`)
        })
        return
      }
      default:
        for (const prop of Object.values(value.props)) visit(prop, at)
    }
  }
  visit(root, undefined)
  return issues
}

function formulaProblem(fn: unknown, vars: unknown, given: readonly string[]): string | undefined {
  if (isAstNode(fn)) return undefined
  if (typeof fn !== "string") return 'fn must be a string, such as "m * (1 + r)^x".'
  const read = readFormula(fn)
  if (read.kind === FORMULA_READ_KIND.invalid) return `${read.reason}.`
  if (vars !== undefined && !isRecord(vars)) return undefined
  const missing = missingVariables(read.formula, [...given, ...Object.keys(vars ?? {})])
  if (missing.length === 0) return undefined
  const names = missing.map((name) => `\`${name}\``).join(", ")
  return `${names} ${missing.length === 1 ? "is" : "are"} not in vars; add ${missing.length === 1 ? "it" : "them"} to vars (a number or a $variable).`
}
