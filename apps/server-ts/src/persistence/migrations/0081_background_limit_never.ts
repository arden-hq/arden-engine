import type { Migration } from "./index.js"

export const backgroundLimitNever: Migration = {
  version: 81,
  name: "background_limit_never",
  foreignKeys: { kind: "enforced" },
  up: () => {}
}
