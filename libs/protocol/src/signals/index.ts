/**
 * The outside sources Arden reads signals from: mail and GitHub notifications
 * today, more later (calendars, chat, trackers). A new source is one entry
 * here and an adapter that fetches its items; storage takes any source id
 * (server migration 0047), and a client that does not know one yet shows its
 * id.
 */
export const SIGNAL_SOURCES = {
  gmail: { label: "Gmail", brand: "gmail" },
  github: { label: "GitHub", brand: "github" }
} as const satisfies Record<string, { readonly label: string; readonly brand: string }>

export type SignalSource = keyof typeof SIGNAL_SOURCES

export const SIGNAL_SOURCE_IDS = Object.keys(SIGNAL_SOURCES) as ReadonlyArray<SignalSource>

const known = (source: string): source is SignalSource => Object.hasOwn(SIGNAL_SOURCES, source)

/** How a source reads to the person, for any stored id. */
export const signalSourceLabel = (source: string): string =>
  known(source) ? SIGNAL_SOURCES[source].label : source

/** The brand mark slug for a source; an unknown one gets a letter mark. */
export const signalSourceBrand = (source: string): string =>
  known(source) ? SIGNAL_SOURCES[source].brand : source
