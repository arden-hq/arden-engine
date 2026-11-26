export const END_KIND = {
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
  restart: "restart",
  needsReview: "needs_review"
} as const

export type EndKind = (typeof END_KIND)[keyof typeof END_KIND]

const END_KIND_OF: Readonly<Record<string, EndKind>> = {
  completed: END_KIND.finished,
  succeeded: END_KIND.finished,
  failed: END_KIND.failed,
  error: END_KIND.failed,
  cancelled: END_KIND.stopped,
  interrupted: END_KIND.restart,
  needs_attention: END_KIND.needsReview
}

export const endKindOf = (status: string | null | undefined): EndKind | undefined =>
  status != null && Object.hasOwn(END_KIND_OF, status) ? END_KIND_OF[status] : undefined

export const isQuietEnd = (kind: EndKind | undefined): boolean =>
  kind === END_KIND.stopped || kind === END_KIND.restart
