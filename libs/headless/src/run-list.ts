import {
  RUN_LIST_FILTER,
  RUN_LIST_PAGE_MAX,
  RUN_PAGE,
  RUN_PAGE_NEXT,
  runRoutes,
  type RunList,
  type RunPage
} from "@arden-hq/protocol/runs"

export interface HeadlessRunListOptions {
  readonly sessionId?: string
  readonly active?: boolean
}

export const listAllRuns = async (
  options: HeadlessRunListOptions,
  read: (path: string) => Promise<RunList>
): Promise<RunList> => {
  const runs: Array<RunList["runs"][number]> = []
  let page: RunPage<string> = { kind: RUN_PAGE.first }
  for (;;) {
    const listed = await read(
      runRoutes.list({
        filter:
          options.sessionId === undefined
            ? { kind: RUN_LIST_FILTER.all }
            : { kind: RUN_LIST_FILTER.session, session_id: options.sessionId },
        active: options.active === true,
        limit: RUN_LIST_PAGE_MAX,
        page
      })
    )
    runs.push(...listed.runs)
    if (listed.next.kind === RUN_PAGE_NEXT.end)
      return { runs, next: listed.next, idle: listed.idle }
    page = { kind: RUN_PAGE.after, cursor: listed.next.cursor }
  }
}
