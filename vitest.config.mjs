import { readdirSync } from "node:fs"

const workspaces = [
  ...readdirSync(new URL("./libs", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `libs/${entry.name}`),
  "apps/cli",
  "apps/server-ts"
]

export default {
  resolve: { conditions: ["arden-source"] },
  ssr: { resolve: { conditions: ["arden-source"], externalConditions: ["arden-source"] } },
  test: {
    ...(process.cwd() === import.meta.dirname
      ? { projects: workspaces.map((root) => ({ extends: true, test: { name: root, root } })) }
      : {}),
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
}
