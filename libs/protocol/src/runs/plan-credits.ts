import type { PlanCredits } from "./contracts.js"

export const hasPlanCredits = (credits: PlanCredits | null | undefined): boolean =>
  credits?.kind === "unlimited" || credits?.available === true
