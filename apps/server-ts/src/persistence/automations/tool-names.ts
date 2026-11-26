export const AUTOMATION_WRITE_TOOL = {
  create: "automation_create",
  update: "automation_update"
} as const

export type AutomationWriteTool = (typeof AUTOMATION_WRITE_TOOL)[keyof typeof AUTOMATION_WRITE_TOOL]
