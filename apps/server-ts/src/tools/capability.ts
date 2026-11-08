import type { CapabilityCandidate, CapabilityProposal } from "@arden-hq/protocol/chat"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { mcpPresetCatalog } from "../mcp/presets.js"

import { ToolExecutionStore } from "../persistence/tools/store.js"
import type { ConnectedServer, OfferCandidate } from "../persistence/capability-offers/match.js"
import { CapabilityOfferStore } from "../persistence/capability-offers/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { ownerKeystrokes } from "../persistence/transcript/owner-words.js"
import { McpConnections } from "../mcp/service.js"
import { refusalText, vetServerRequest } from "./capability-server.js"

const MAX_CANDIDATES = 3
const MAX_CARDS_PER_RUN = 1

const NeedSchema = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(300)).annotate({
  description:
    "What you cannot currently do, in your own words. Not a product name — the server matches this against its presets and picks the ids."
})

const ServerSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(2000)).annotate({
    description: "The address exactly as the user wrote it in chat."
  }),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description: "A short lowercase label for the connection. Optional."
    })
  ),
  auth: Schema.optionalKey(
    Schema.Literals(["oauth", "none", "headers"]).annotate({
      description: "How the user said it signs in. Defaults to oauth."
    })
  )
}).annotate({ description: "A server the user gave you by URL." })

const ParametersSchema = Schema.Struct({
  need: NeedSchema,
  server: Schema.optionalKey(ServerSchema)
})

interface CapabilityToolServices {
  readonly executions: ToolExecutionStore["Service"]
  readonly connectedServers: () => Promise<ReadonlyArray<ConnectedServer>>
  readonly offers: CapabilityOfferStore["Service"]
  readonly ownerWords: (sessionId: string) => Promise<ReadonlyArray<string>>
  readonly isChildAgent: (sessionId: string) => Promise<boolean>
}

const OWNER_PAGE = 250
const MAX_OWNER_PAGES = 40

const readOwnerWords = async (
  transcript: TranscriptQueries["Service"],
  sessionId: string
): Promise<ReadonlyArray<string>> => {
  const words: string[] = []
  let cursor = -1
  for (let page = 0; page < MAX_OWNER_PAGES; page += 1) {
    const rows = await Effect.runPromise(
      transcript.ownerMessagesAfter({ sessionId, sequence: cursor, limit: OWNER_PAGE })
    )
    for (const row of rows) words.push(ownerKeystrokes(row.envelope))
    const last = rows[rows.length - 1]
    if (rows.length < OWNER_PAGE || last === undefined || last.sequence <= cursor) break
    cursor = last.sequence
  }
  return words
}

const SEARCH_STOP_WORDS = new Set(["and", "for", "from", "need", "the", "with"])
const searchWords = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length >= 3 && !SEARCH_STOP_WORDS.has(word)) ?? []
  )

const matchingPresets = (
  need: string,
  catalog: ReturnType<typeof mcpPresetCatalog>
): ReturnType<typeof mcpPresetCatalog> => {
  const needWords = searchWords(need)
  return catalog
    .map((preset, index) => {
      const nameWords = searchWords(`${preset.id} ${preset.title}`)
      const descriptionWords = searchWords(preset.description)
      let score = 0
      let named = false
      for (const word of needWords) {
        if (nameWords.has(word)) {
          score += 4
          named = true
        }
        if (descriptionWords.has(word)) score += 1
      }
      return { preset, score, index, named }
    })
    .filter(({ named }) => named)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ preset }) => preset)
}

const spent = (
  results: ReadonlyArray<{
    readonly runId: string
    readonly data: Readonly<Record<string, unknown>>
  }>,
  runId: string
): { readonly cardsThisRun: number; readonly proposedIds: ReadonlySet<string> } => {
  const proposedIds = new Set<string>()
  let cardsThisRun = 0
  for (const result of results) {
    const candidates = result.data["candidates"]
    if (!Array.isArray(candidates) || candidates.length === 0) continue
    if (result.runId === runId) cardsThisRun += 1
    for (const candidate of candidates) {
      const id = (candidate as { readonly id?: unknown }).id
      if (typeof id === "string") proposedIds.add(id)
    }
  }
  return { cardsThisRun, proposedIds }
}

const BUILT_IN_SERVICE = /\b(gmail|google|calendar)\b/i

const presetCandidate = (
  preset: ReturnType<typeof mcpPresetCatalog>[number]
): CapabilityCandidate => ({
  kind: "mcp_preset",
  id: preset.id,
  title: preset.title,
  description: preset.description,
  setup_url: preset.setupUrl ?? null
})

const offerCandidates = (
  candidates: ReadonlyArray<CapabilityCandidate>
): ReadonlyArray<OfferCandidate> =>
  candidates.map((candidate): OfferCandidate => {
    switch (candidate.kind) {
      case "mcp_preset":
        return { kind: "preset", id: candidate.id, title: candidate.title }
      case "mcp_custom":
        return { kind: "url", url: candidate.url, title: candidate.title }
    }
  })

const makeCapabilityProposeTool = (services: CapabilityToolServices): ServerTool =>
  defineServerTool({
    name: "capability_propose",
    description: [
      "Offer the user a connection that would unblock what they asked for.",
      "Call this only when you cannot proceed without one — never to list options.",
      "Describe the need; the server resolves which presets fit and may return none.",
      "It also offers a server the user gave you by URL (server), only if they wrote that URL in chat.",
      "This installs nothing: the user decides."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Propose Capability",
      kind: "tool",
      action: "read",
      approval_preview: "Suggest an integration that would unblock this request.",
      source: "_system",
      presentation: "conversation",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const { need, server } = input
      const keepOffer = async (candidates: ReadonlyArray<CapabilityCandidate>) => {
        try {
          await Effect.runPromise(
            services.offers.record({
              sessionId: ctx.run.sessionId,
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId,
              candidates: offerCandidates(candidates),
              connected: await services.connectedServers()
            })
          )
        } catch (cause) {
          Effect.runSync(Effect.logWarning("Could not keep the connection offer", { cause }))
        }
      }
      if (server === undefined && BUILT_IN_SERVICE.test(need)) {
        return {
          result: [
            "Gmail and Google Calendar are Arden's built-in Google connection, not a catalog entry.",
            "Call the Gmail or Calendar tool you need: if the account is disconnected, its own reconnect prompt appears for the user.",
            "Do not offer another integration."
          ].join(" "),
          preview: "Built-in Google connection",
          data: { need, candidates: [] } satisfies CapabilityProposal
        }
      }
      const history = await Effect.runPromise(
        services.executions
          .priorResults({ sessionId: ctx.run.sessionId, toolName: "capability_propose" })
          .pipe(Effect.catch(() => Effect.succeed([])))
      )
      const { cardsThisRun, proposedIds } = spent(history, ctx.run.runId)
      if (cardsThisRun >= MAX_CARDS_PER_RUN) {
        return {
          result: "A capability was already proposed in this run. Continue without another.",
          preview: "Already proposed",
          data: { need, candidates: [] } satisfies CapabilityProposal
        }
      }

      if (server !== undefined) {
        const verdict = vetServerRequest({
          url: server.url,
          name: server.name,
          ownerWords: await services.ownerWords(ctx.run.sessionId),
          childAgent: await services.isChildAgent(ctx.run.sessionId)
        })
        if (verdict.kind === "refused") {
          return {
            result: refusalText(verdict.reason),
            preview: "Server not offered",
            data: { need, candidates: [] } satisfies CapabilityProposal
          }
        }
        if (proposedIds.has(verdict.id)) {
          return {
            result:
              "This server was already offered in this chat. Continue without offering it again.",
            preview: "Already offered",
            data: { need, candidates: [] } satisfies CapabilityProposal
          }
        }
        const custom: CapabilityCandidate = {
          kind: "mcp_custom",
          id: verdict.id,
          title: verdict.name,
          url: verdict.url,
          auth: server.auth ?? "oauth"
        }
        await keepOffer([custom])
        return {
          result: [
            `Offered ${custom.title} at the address the user gave.`,
            "The connect choice is visible in chat. Wait for the user.",
            "Do not open Settings and do not act as if it is connected."
          ].join(" "),
          preview: custom.title,
          data: { need, candidates: [custom] } satisfies CapabilityProposal
        }
      }

      const catalog = mcpPresetCatalog()
      const presets = matchingPresets(need, catalog)
      const resolved = presets.map(presetCandidate)

      const seen = new Set(proposedIds)
      const candidates: Array<CapabilityCandidate> = []
      for (const candidate of resolved) {
        if (seen.has(candidate.id)) continue
        seen.add(candidate.id)
        candidates.push(candidate)
        if (candidates.length === MAX_CANDIDATES) break
      }

      const proposal: CapabilityProposal = { need, candidates }
      const data = { need: proposal.need, candidates: proposal.candidates }
      if (candidates.length === 0) {
        return {
          result: "No preset covers that. Say plainly that you cannot do it.",
          preview: "No capability fits",
          data
        }
      }
      await keepOffer(candidates)
      return {
        result: [
          `Offered ${candidates.length === 1 ? "one option" : `${candidates.length} options`}:`,
          `${candidates.map((candidate) => candidate.title).join(", ")}.`,
          "The connection choice is visible in chat. Wait for the user.",
          "Do not open Settings and do not act as if it is connected."
        ].join(" "),
        preview: candidates.map((candidate) => candidate.title).join(", "),
        data
      }
    }
  })

export const capabilityTools = Effect.gen(function* () {
  const sessions = yield* SessionQueries
  const transcript = yield* TranscriptQueries
  const mcp = yield* McpConnections
  return [
    makeCapabilityProposeTool({
      executions: yield* ToolExecutionStore,
      offers: yield* CapabilityOfferStore,
      connectedServers: async () =>
        (await Effect.runPromise(mcp.snapshot()))
          .filter((server) => server.status === "connected")
          .map((server) => ({
            presetId: server.presetId ?? undefined,
            url: server.transport.type === "http" ? server.transport.url : undefined
          })),
      ownerWords: (sessionId) => readOwnerWords(transcript, sessionId),
      isChildAgent: async (sessionId) => {
        const header = await Effect.runPromise(sessions.loadHistoryHeader(sessionId))
        return header?.sessionType === "agent"
      }
    })
  ]
})
