export const SIGNAL_SOURCE = { gmail: "gmail", github: "github", calendar: "calendar" } as const

export type SignalSource = (typeof SIGNAL_SOURCE)[keyof typeof SIGNAL_SOURCE]

export const SIGNAL_SOURCES = {
  gmail: { label: "Gmail", brand: "gmail" },
  github: { label: "GitHub", brand: "github" },
  calendar: { label: "Google Calendar", brand: "google-calendar" }
} as const satisfies Record<SignalSource, { readonly label: string; readonly brand: string }>

export const SIGNAL_SOURCE_IDS = Object.keys(SIGNAL_SOURCES) as ReadonlyArray<SignalSource>

export const isSignalSource = (source: string): source is SignalSource =>
  Object.hasOwn(SIGNAL_SOURCES, source)

export const signalSourceLabel = (source: string): string =>
  isSignalSource(source) ? SIGNAL_SOURCES[source].label : source

export const signalSourceBrand = (source: string): string =>
  isSignalSource(source) ? SIGNAL_SOURCES[source].brand : source
