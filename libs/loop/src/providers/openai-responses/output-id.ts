const SYNTHETIC_OUTPUT_ID_PREFIX = "arden-synthetic-output-"

export const OUTPUT_ID_ORIGIN = { provider: "provider", arden: "arden" } as const
export type OutputIdOrigin = (typeof OUTPUT_ID_ORIGIN)[keyof typeof OUTPUT_ID_ORIGIN]

export const syntheticOutputId = (suffix: string | number): string =>
  `${SYNTHETIC_OUTPUT_ID_PREFIX}${suffix}`

export const outputIdOrigin = (id: string): OutputIdOrigin =>
  id.startsWith(SYNTHETIC_OUTPUT_ID_PREFIX) ? OUTPUT_ID_ORIGIN.arden : OUTPUT_ID_ORIGIN.provider
