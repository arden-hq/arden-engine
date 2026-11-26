import { CHANGE_ENTRY_OUTCOME } from "@arden-hq/protocol/chat"
import { ReceiptOutcomeSchema } from "@arden-hq/protocol/effect/chat"
export { ReceiptOutcomeSchema } from "@arden-hq/protocol/effect/chat"
import { Schema } from "effect"

export const TOOL_EFFECT = {
  none: "none",
  runRecord: "run_record",
  ardenDb: "arden_db",
  localFiles: "local_files",
  external: "external"
} as const
export type ToolEffect = (typeof TOOL_EFFECT)[keyof typeof TOOL_EFFECT]
export const ToolEffectSchema = Schema.Literals(Object.values(TOOL_EFFECT))

type ReceiptOutcome = typeof ReceiptOutcomeSchema.Type

export interface EffectTarget {
  readonly source: string
  readonly objectId: string
  readonly title?: string
  readonly href?: string
  readonly place?: string
}

export const MAX_CALL_TARGETS = 50

const EFFECT_TARGET_ORIGIN = { named: "named", created: "created" } as const
export type EffectTargetOrigin = (typeof EFFECT_TARGET_ORIGIN)[keyof typeof EFFECT_TARGET_ORIGIN]

const CALL_SETTLED = { succeeded: "succeeded", threw: "threw" } as const
type CallSettled = (typeof CALL_SETTLED)[keyof typeof CALL_SETTLED]

export interface CallEffects {
  readonly target: (target: EffectTarget, options?: { readonly creates?: boolean }) => Promise<void>
  readonly created: (target: EffectTarget) => Promise<void>
  readonly applied: () => void
  readonly unchanged: () => void
  readonly sent: () => void
  readonly failed: () => void
}

export interface CallEffectLedger extends CallEffects {
  readonly outcome: (settled: CallSettled) => {
    readonly outcome: Exclude<ReceiptOutcome, typeof CHANGE_ENTRY_OUTCOME.unknown>
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
        : declare(
            target,
            options?.creates === true ? EFFECT_TARGET_ORIGIN.created : EFFECT_TARGET_ORIGIN.named,
            false
          ),
    created: (target) => declare(target, EFFECT_TARGET_ORIGIN.created, true),
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
      if (applied) return { outcome: CHANGE_ENTRY_OUTCOME.applied, recorded: true }
      if (pending) return { outcome: CHANGE_ENTRY_OUTCOME.unconfirmed, recorded: true }
      if (failed) return { outcome: CHANGE_ENTRY_OUTCOME.failed, recorded: true }
      if (unchanged) return { outcome: CHANGE_ENTRY_OUTCOME.noOp, recorded: true }
      return settled === CALL_SETTLED.threw
        ? { outcome: CHANGE_ENTRY_OUTCOME.noOp, recorded: true }
        : { outcome: CHANGE_ENTRY_OUTCOME.unconfirmed, recorded: false }
    }
  }
}

export const recordApplied = async <A>(effects: CallEffects, write: Promise<A>): Promise<A> => {
  const value = await write
  effects.applied()
  return value
}
