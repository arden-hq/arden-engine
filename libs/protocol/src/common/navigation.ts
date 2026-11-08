/** Settings destinations the current Desktop can open directly. */
export type AppSettingsTabId =
  | "integrations"
  | "models"
  | "usage"
  | "tools"
  | "skills"
  | "recipes"
  | "permissions"
  | "appearance"
  | "storage"
  | "archive"
  | "iphone"

/** Stable Desktop navigation vocabulary carried by agent requests. */
export type AppDestination =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly session_id: string; readonly turn_id?: string }
  | { readonly kind: "settings"; readonly tab?: AppSettingsTabId | null }
  | { readonly kind: "automation"; readonly task_id?: string | null }
  | { readonly kind: "task"; readonly item_id: string }
  | { readonly kind: "memory"; readonly path?: string | null }
  | { readonly kind: "space"; readonly space_id: string }
