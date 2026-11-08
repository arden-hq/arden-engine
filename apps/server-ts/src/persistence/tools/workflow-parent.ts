const DETACHED_CHILD_MARKERS = [":workflow:", ":code:"] as const

export const workflowParentToolCallId = (toolCallId: string): string | undefined => {
  const markers = DETACHED_CHILD_MARKERS.map((marker) => toolCallId.indexOf(marker)).filter(
    (index) => index > 0
  )
  return markers.length === 0 ? undefined : toolCallId.slice(0, Math.min(...markers))
}
