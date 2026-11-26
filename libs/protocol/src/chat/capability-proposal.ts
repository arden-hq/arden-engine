export const CAPABILITY_CANDIDATE = { mcpPreset: "mcp_preset", mcpCustom: "mcp_custom" } as const

export type CapabilityCandidate =
  | {
      readonly kind: typeof CAPABILITY_CANDIDATE.mcpPreset
      readonly id: string
      readonly title: string
      readonly description: string
      readonly setup_url: string | null
    }
  | {
      readonly kind: typeof CAPABILITY_CANDIDATE.mcpCustom
      readonly id: string
      readonly title: string
      readonly url: string
      readonly auth: "oauth" | "none" | "headers"
    }

export interface CapabilityProposal {
  readonly need: string
  readonly candidates: ReadonlyArray<CapabilityCandidate>
}
