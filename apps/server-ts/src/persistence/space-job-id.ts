export const spaceJobId = (spaceId: string): string => `space:${spaceId}`

export const taskJobId = (itemId: string): string => `task:${itemId}`

export const taskOfJob = (automationId: string): string | undefined =>
  automationId.startsWith("task:") ? automationId.slice("task:".length) : undefined
