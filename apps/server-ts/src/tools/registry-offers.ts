import { makeToolApprovalPolicy } from "./approval-policy.js"
import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import { Effect } from "effect"
import { SESSION_PERMISSION } from "@arden-hq/protocol/permissions"
import { APPROVAL_SOURCE } from "../execution/approval-source.js"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { makePermissionOffers } from "./permission-offer.js"
import { namedCommandGrant } from "./shell-policy.js"
import { readCommandViews } from "../execution/rules.js"
import { WorkStore } from "../persistence/work/store.js"
import { PermissionStore } from "../persistence/permissions/store.js"
import { McpStore } from "../persistence/mcp/store.js"
import { mcpServiceTitle } from "../mcp/transport.js"
import { type PermissionOffers } from "./permission-offer-types.js"

export const makeRegistryOffers = ({
  permissions,
  work,
  approvalPolicy,
  policy,
  sessions,
  rules,
  mcpServers,
  compileWords
}: {
  readonly permissions: PermissionStore["Service"]
  readonly work: WorkStore["Service"]
  readonly approvalPolicy: ReturnType<typeof makeToolApprovalPolicy>
  readonly policy: ApprovalPolicyStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly rules: PermissionRules["Service"]
  readonly mcpServers: McpStore["Service"]
  readonly compileWords: Parameters<typeof makePermissionOffers>[0]["compileWords"]
}): PermissionOffers =>
  makePermissionOffers({
    permissions,
    work,
    live: (run) =>
      Effect.runPromise(approvalPolicy.live({ runId: run.runId, authority: run.authority })),
    modeHolder: (run) => {
      const follows = run.authority.approval.follows
      if (follows.kind !== APPROVAL_SOURCE.chat) return Promise.resolve(undefined)
      return Effect.runPromise(
        Effect.gen(function* () {
          const permission = yield* policy.session(follows.session_id)
          if (permission.kind !== SESSION_PERMISSION.chat) return undefined
          const session = yield* sessions.loadHistoryHeader(follows.session_id)
          return {
            sessionId: follows.session_id,
            name: session?.name ?? "",
            mode: permission.approval_mode
          }
        })
      )
    },
    commandGrant: async (run, command) => {
      const views = await Effect.runPromise(readCommandViews(rules, run.authority))
      return {
        grant: await namedCommandGrant(views.run, command),
        system: await namedCommandGrant(views.system, command),
        alwaysAsk: views.alwaysAsk
      }
    },
    compileWords,
    connectorTitles: () =>
      Effect.runPromise(
        mcpServers
          .list()
          .pipe(
            Effect.map(
              (servers) => new Map(servers.map((server) => [server.name, mcpServiceTitle(server)]))
            )
          )
      )
  })
