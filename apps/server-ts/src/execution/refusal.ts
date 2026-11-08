import { listWords } from "@arden-hq/std/count"
import type { DenyRule, Path } from "./decide.js"

export interface Refusal {
  readonly what: string
  readonly rule: DenyRule
  readonly instead: ReadonlyArray<Path>
}

const BREAKER_AFTER = 2

const pathText = (path: Path): string => {
  switch (path.kind) {
    case "tool":
      return `use ${path.name}`
    case "ask_user":
      return "ask the user with ask_user"
    case "report":
      return "say it in your final reply or report"
  }
}

export const renderRefusal = (refusal: Refusal): string => {
  const instead =
    refusal.instead.length === 0
      ? "Do not retry."
      : `Instead, ${listWords(refusal.instead.map(pathText), "or")}.`
  return `${refusal.what}. ${instead}`
}

export const breakerNote = (earlier: number): string =>
  earlier >= BREAKER_AFTER
    ? " This was refused several times in this run: stop trying variations; ask the user or end with a blocked report."
    : ""
