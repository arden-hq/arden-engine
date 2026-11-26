import { SESSION_TRIAGE_DECISION, type SessionTriageDecision } from "@arden-hq/protocol/sessions"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { SessionTriageDecisionSchema } from "@arden-hq/protocol/effect/sessions"
import { DateTime, Option, Schema } from "effect"

const TRIAGE_RECHECK_MESSAGES = 20

const checked = {
  decision: SessionTriageDecisionSchema,
  checked_at: IsoDateTimeStringSchema,
  checked_count: Schema.Natural
}

export const TRIAGE_OUTCOME = {
  suggested: "suggested",
  dismissed: "dismissed",
  filed: "filed",
  undone: "undone"
} as const

export const StoredTriageSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals([TRIAGE_OUTCOME.suggested, TRIAGE_OUTCOME.dismissed] as const),
    ...checked
  }),
  Schema.Struct({
    outcome: Schema.Literals([TRIAGE_OUTCOME.filed, TRIAGE_OUTCOME.undone] as const),
    ...checked,
    filed: Schema.Struct({
      space_id: Schema.NonEmptyString,
      title: Schema.String,
      created: Schema.Boolean
    })
  })
])

export type StoredTriage = (typeof StoredTriageSchema)["Type"]

export const NO_TRIAGE: SessionTriageDecision = {
  decision: SESSION_TRIAGE_DECISION.none,
  target: null,
  new_title: null,
  rationale: ""
}

export const freshTriage = (
  stored: StoredTriage | undefined,
  chat: { readonly messageCount: number; readonly lastActivity: string },
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal()
): SessionTriageDecision | undefined => {
  if (stored === undefined) return undefined
  switch (stored.outcome) {
    case TRIAGE_OUTCOME.filed:
    case TRIAGE_OUTCOME.undone:
      return NO_TRIAGE
    case TRIAGE_OUTCOME.suggested:
    case TRIAGE_OUTCOME.dismissed: {
      const grown = chat.messageCount >= stored.checked_count + TRIAGE_RECHECK_MESSAGES
      const newDay = localDay(chat.lastActivity, zone) > localDay(stored.checked_at, zone)
      if (grown || newDay) return undefined
      return stored.outcome === TRIAGE_OUTCOME.dismissed ? NO_TRIAGE : stored.decision
    }
  }
}

const localDay = (iso: string, zone: DateTime.TimeZone): string =>
  Option.match(DateTime.make(iso), {
    onNone: () => "",
    onSome: (instant) => DateTime.formatIsoDate(DateTime.setZone(instant, zone))
  })
