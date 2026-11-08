import { expect, it } from "vitest"
import { ProtocolError } from "@arden-hq/protocol"
import { chatRoutes } from "@arden-hq/protocol/chat"
import { permissionRoutes } from "@arden-hq/protocol/permissions"
import { wikiRoutes } from "@arden-hq/protocol/wiki"

const routes = [
  ["chat events", chatRoutes.events],
  ["chat queue", chatRoutes.queue],
  [
    "queued message",
    (id: string) => chatRoutes.queuedMessage({ sessionId: "session", clientId: id })
  ],
  ["Space rules", permissionRoutes.spaceRules],
  ["Wiki page", wikiRoutes.page],
  ["Wiki archived-page restore", wikiRoutes.restoreArchived],
  ["Wiki history restore", (id: string) => wikiRoutes.historyRestore("page", id)],
  ["Wiki rename decision", (id: string) => wikiRoutes.renameDecision(id, "accept")]
] as const

it.each(routes)(
  "%s rejects relative identifiers while preserving encoded segments",
  (_name, route) => {
    for (const id of [".", ".."]) expect(() => route(id)).toThrow(ProtocolError)
    const path = route("folder/name")
    expect(new URL(path, "https://arden.test").pathname).toContain("folder%2Fname")
  }
)
