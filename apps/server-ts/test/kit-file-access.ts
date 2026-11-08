import type { SharedFileAccess } from "../src/tools/shared-files.js"

const unexpected = (): never => {
  throw new Error("This wire fixture does not supply files")
}

export const emptyFileAccess: SharedFileAccess = {
  prepare: async ({ refs }) => (refs.length === 0 ? [] : unexpected()),
  read: async ({ files }) => (files.length === 0 ? [] : unexpected()),
  forExecution: async ({ refs }) => (refs.length === 0 ? [] : unexpected()),
  publish: unexpected
}
