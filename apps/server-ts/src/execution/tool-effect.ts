import { ReceiptOutcomeSchema } from "@arden-hq/protocol/effect/chat"
export { ReceiptOutcomeSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"

export const ToolEffectSchema = Schema.Literals([
  "none",
  "run_record",
  "arden_db",
  "local_files",
  "external"
])
export type ToolEffect = typeof ToolEffectSchema.Type

type ReceiptOutcome = typeof ReceiptOutcomeSchema.Type

export interface EffectTarget {
  readonly source: string
  readonly objectId: string
  readonly title?: string
  readonly href?: string
  readonly place?: string
}

export const MAX_CALL_TARGETS = 50

export type EffectTargetOrigin = "named" | "created"

export interface CallEffects {
  readonly target: (target: EffectTarget, options?: { readonly creates?: boolean }) => Promise<void>
  readonly created: (target: EffectTarget) => Promise<void>
  readonly applied: () => void
  readonly unchanged: () => void
  readonly sent: () => void
  readonly failed: () => void
}

export interface CallEffectLedger extends CallEffects {
  readonly outcome: (settled: "succeeded" | "threw") => {
    readonly outcome: Exclude<ReceiptOutcome, "unknown">
    readonly recorded: boolean
  }
}

export const makeCallEffectLedger = (
  declare: (target: EffectTarget, origin: EffectTargetOrigin, answered: boolean) => Promise<void>
): CallEffectLedger => {
  let applied = false
  let unchanged = false
  let pending = false
  let failed = false
  return {
    target: (target, options) =>
      applied || pending || failed
        ? Promise.reject(new Error("A call declares its target before its request leaves"))
        : declare(target, options?.creates === true ? "created" : "named", false),
    created: (target) => declare(target, "created", true),
    applied: () => {
      applied = true
      pending = false
    },
    unchanged: () => {
      unchanged = true
    },
    sent: () => {
      pending = true
    },
    failed: () => {
      failed = true
      pending = false
    },
    outcome: (settled) => {
      if (applied) return { outcome: "applied", recorded: true }
      if (pending) return { outcome: "unconfirmed", recorded: true }
      if (failed) return { outcome: "failed", recorded: true }
      if (unchanged) return { outcome: "no_op", recorded: true }
      return settled === "threw"
        ? { outcome: "no_op", recorded: true }
        : { outcome: "unconfirmed", recorded: false }
    }
  }
}

export const recordApplied = async <A>(effects: CallEffects, write: Promise<A>): Promise<A> => {
  const value = await write
  effects.applied()
  return value
}
