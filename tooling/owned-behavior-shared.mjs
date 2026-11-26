/**
 * @typedef {({ selector: string, pattern?: never } | { pattern: string, selector?: never }) & {
 *   message: string
 *   owners: string[]
 *   exempt?: string[]
 *   exemptDirs?: string[]
 *   nodeOnly?: boolean
 *   rendererOnly?: boolean
 *   text?: true
 *   serverOnly?: true
 * }} OwnedBehavior
 */
export const migrationsDir = "apps/server-ts/src/persistence/migrations/"
export const electronDir = "apps/desktop/electron/"
export const textOwners = ["libs/std/src/text.ts"]
