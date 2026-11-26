export type AppSettingsTabId =
  | "integrations"
  | "models"
  | "usage"
  | "tools"
  | "skills"
  | "permissions"
  | "appearance"
  | "storage"
  | "archive"
  | "iphone"

export const SESSION_DESTINATION_TURN = { latest: "latest", turn: "turn" } as const
export const SETTINGS_DESTINATION_TAB = { general: "general", tab: "tab" } as const
export const AUTOMATION_DESTINATION = { list: "list", automation: "automation" } as const
export const MEMORY_DESTINATION = { index: "index", page: "page" } as const

export type SessionDestinationTurn =
  | { readonly kind: typeof SESSION_DESTINATION_TURN.latest }
  | { readonly kind: typeof SESSION_DESTINATION_TURN.turn; readonly turn_id: string }

export type SettingsDestinationTab =
  | { readonly kind: typeof SETTINGS_DESTINATION_TAB.general }
  | { readonly kind: typeof SETTINGS_DESTINATION_TAB.tab; readonly tab_id: AppSettingsTabId }

export type AutomationDestinationTarget =
  | { readonly kind: typeof AUTOMATION_DESTINATION.list }
  | { readonly kind: typeof AUTOMATION_DESTINATION.automation; readonly task_id: string }

export type MemoryDestinationTarget =
  | { readonly kind: typeof MEMORY_DESTINATION.index }
  | { readonly kind: typeof MEMORY_DESTINATION.page; readonly path: string }

export type AppDestination =
  | { readonly kind: "home" }
  | {
      readonly kind: "session"
      readonly session_id: string
      readonly turn: SessionDestinationTurn
    }
  | { readonly kind: "settings"; readonly tab: SettingsDestinationTab }
  | { readonly kind: "automation"; readonly target: AutomationDestinationTarget }
  | { readonly kind: "task"; readonly item_id: string }
  | { readonly kind: "memory"; readonly target: MemoryDestinationTarget }
  | { readonly kind: "space"; readonly space_id: string }

export const NAVIGATION_ASKED_BY = { untracked: "untracked", tool_call: "tool_call" } as const

export type NavigationAskedBy =
  | { readonly kind: typeof NAVIGATION_ASKED_BY.untracked }
  | { readonly kind: typeof NAVIGATION_ASKED_BY.tool_call; readonly tool_call_id: string }
