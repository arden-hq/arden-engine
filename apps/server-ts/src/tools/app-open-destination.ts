import { ToolExecutionError } from "@arden-hq/loop"
import type { AppDestination } from "@arden-hq/protocol"
import {
  AUTOMATION_DESTINATION,
  MEMORY_DESTINATION,
  SESSION_DESTINATION_TURN,
  SETTINGS_DESTINATION_TAB
} from "@arden-hq/protocol/common"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import type { AutomationCatalog } from "../persistence/automations/catalog.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"
import type { SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import { pageWithItem, type WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import type { WikiError } from "../wiki/errors.js"
import type { Wiki } from "../wiki/service.js"
import { TOOL_DESTINATION, type ToolDestination } from "./app-destination.js"
import { toolFailure } from "./tool-failure.js"

interface DestinationServices {
  readonly automations: AutomationCatalog["Service"]
  readonly spaces: SpaceStore["Service"]
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
}

const automationFailure = (error: AutomationStoreError): ToolExecutionError =>
  toolFailure(error, "Automation unavailable")

const spaceFailure = (error: SpaceStoreError): ToolExecutionError =>
  toolFailure(error, "Space unavailable")

const workFailure = (error: WorkStoreError): ToolExecutionError =>
  toolFailure(error, "Work unavailable")

const wikiFailure = (error: WikiError): ToolExecutionError =>
  toolFailure(error, "Memory unavailable")

export const resolveDestination = async (
  services: DestinationServices,
  destination: ToolDestination,
  sessionIdOf: (sessionRef: string) => Promise<string>,
  signal: AbortSignal
): Promise<AppDestination> => {
  switch (destination.kind) {
    case TOOL_DESTINATION.home:
      return { kind: "home" }
    case TOOL_DESTINATION.session: {
      return {
        kind: "session",
        session_id: await sessionIdOf(destination.session_ref),
        turn: { kind: SESSION_DESTINATION_TURN.latest }
      }
    }
    case TOOL_DESTINATION.settings:
      return {
        kind: "settings",
        tab:
          destination.tab === undefined
            ? { kind: SETTINGS_DESTINATION_TAB.general }
            : { kind: SETTINGS_DESTINATION_TAB.tab, tab_id: destination.tab }
      }
    case TOOL_DESTINATION.automation: {
      if (destination.automation_ref === undefined)
        return { kind: "automation", target: { kind: AUTOMATION_DESTINATION.list } }
      const automations = await Effect.runPromise(
        services.automations.list().pipe(Effect.mapError(automationFailure)),
        { signal }
      )
      const automation = automations.find(
        (candidate) => candidate.automation_ref === destination.automation_ref
      )
      if (automation === undefined) {
        throw new ToolExecutionError(`No Automation ${destination.automation_ref}`, {
          preview: "Automation not found",
          retryable: false
        })
      }
      return {
        kind: "automation",
        target: { kind: AUTOMATION_DESTINATION.automation, task_id: automation.task_id }
      }
    }
    case TOOL_DESTINATION.task: {
      const page = await Effect.runPromise(
        services.work.page(pageWithItem(destination.item_id)).pipe(Effect.mapError(workFailure)),
        { signal }
      )
      if (!page.items.some((item) => item.item_id === destination.item_id)) {
        throw new ToolExecutionError(`No active Task ${destination.item_id}`, {
          preview: "Task not found",
          retryable: false
        })
      }
      return { kind: "task", item_id: destination.item_id }
    }
    case TOOL_DESTINATION.memory: {
      if (destination.path === undefined)
        return { kind: "memory", target: { kind: MEMORY_DESTINATION.index } }
      const snapshot = await Effect.runPromise(
        services.wiki.snapshot().pipe(Effect.mapError(wikiFailure)),
        { signal }
      )
      const exists = snapshot.wholeSet.some(
        (record) =>
          record.page.lifecycle === WIKI_PAGE_LIFECYCLE.active &&
          record.resource.path === destination.path
      )
      if (!exists) {
        throw new ToolExecutionError(`No active Memory page at ${destination.path}`, {
          preview: "Memory page not found",
          retryable: false
        })
      }
      return { kind: "memory", target: { kind: MEMORY_DESTINATION.page, path: destination.path } }
    }
    case TOOL_DESTINATION.space: {
      const space = await Effect.runPromise(
        services.spaces.get(destination.space_id).pipe(Effect.mapError(spaceFailure)),
        { signal }
      )
      if (space === null) {
        throw new ToolExecutionError(`No active Space ${destination.space_id}`, {
          preview: "Space not found",
          retryable: false
        })
      }
      return { kind: "space", space_id: space.space_id }
    }
  }
}
