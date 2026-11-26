import { encodingBehaviors } from "./owned-behaviors-encoding.mjs"
import { persistenceBehaviors } from "./owned-behaviors-persistence.mjs"
import { textBehaviors } from "./owned-behaviors-text.mjs"
import { migrationsDir } from "./owned-behavior-shared.mjs"
import { LINT_SCOPE } from "./value-tables.mjs"

/** @typedef {import("./owned-behavior-shared.mjs").OwnedBehavior} OwnedBehavior */
const rendererFiles = "apps/desktop/src/"
/** @param {string} file */
const inRenderer = (file) => file.startsWith(rendererFiles)
const serverFiles = "apps/server-ts/src/"
/** @param {OwnedBehavior} behavior @param {string} file */
const appliesTo = (behavior, file) =>
  !behavior.owners.includes(file) &&
  !(behavior.exempt?.includes(file) ?? false) &&
  !(behavior.exemptDirs?.some((dir) => file.startsWith(dir)) ?? false) &&
  !(behavior.nodeOnly === true && inRenderer(file)) &&
  !(behavior.rendererOnly === true && !inRenderer(file)) &&
  !(behavior.serverOnly === true && !file.startsWith(serverFiles))

/** @type {OwnedBehavior[]} */
const ownedBehaviors = [...textBehaviors, ...encodingBehaviors, ...persistenceBehaviors]
export const exemptDirs = [
  ...new Set(ownedBehaviors.flatMap((behavior) => behavior.exemptDirs ?? []))
].filter((dir) => dir !== migrationsDir)
export const ownerFiles = [
  ...new Set(ownedBehaviors.flatMap((behavior) => [...behavior.owners, ...(behavior.exempt ?? [])]))
]
const rendererPathsImport = {
  selector:
    "ImportDeclaration[source.value=/^@arden-hq\\/std\\/paths$/], ImportExpression[source.value=/^@arden-hq\\/std\\/paths$/]",
  message: "@arden-hq/std/paths is node-only (node:path, node:os); the renderer cannot import it."
}
/** @param {"workspace" | "renderer" | "server" | "frozen" | string} scope */
export const ownedBans = (scope) => ({
  "arden/restricted-owner": [
    "error",
    ...ownedBehaviors
      .filter((behavior) => {
        if (behavior.serverOnly === true && scope !== LINT_SCOPE.server) return appliesTo(behavior, scope)
        if (scope === LINT_SCOPE.workspace || scope === LINT_SCOPE.server) return behavior.rendererOnly !== true
        if (scope === LINT_SCOPE.renderer) return behavior.nodeOnly !== true
        if (scope === LINT_SCOPE.frozen)
          return behavior.rendererOnly !== true && behavior.text !== true && appliesTo(behavior, `${migrationsDir}file.ts`)
        if (scope.endsWith("/"))
          return behavior.rendererOnly !== true && appliesTo(behavior, `${scope}file.ts`)
        return appliesTo(behavior, scope)
      })
      .map(({ selector, pattern, message }) =>
        pattern === undefined ? { selector, message } : { pattern, message }
      ),
    ...(scope === LINT_SCOPE.renderer || inRenderer(scope) ? [rendererPathsImport] : [])
  ]
})
