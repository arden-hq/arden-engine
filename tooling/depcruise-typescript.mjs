// Preloaded into `bun run depcruise` (NODE_OPTIONS=--import). dependency-cruiser
// parses TypeScript with the `typescript` package it resolves from its own
// store folder, which under bun's isolated linker is whichever version bun
// hoisted into node_modules/.bun/node_modules. A fresh install hoists 7.0.2,
// which has no JS API, so dependency-cruiser silently skips every .ts file and
// the gate fails. This hook sends every `typescript` import to the root's own
// devDependency (6.0.3), whatever bun hoisted.
import { createRequire, registerHooks } from "node:module"
import { pathToFileURL } from "node:url"

// Resolved before the hook is registered: a resolve inside the hook would
// re-enter it. typescript has no `exports` map, so a subpath is a file path.
const main = createRequire(import.meta.url).resolve("typescript")
const packageRoot = new URL("./", pathToFileURL(createRequire(import.meta.url).resolve("typescript/package.json")))

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typescript") return { url: pathToFileURL(main).href, shortCircuit: true }
    if (specifier.startsWith("typescript/")) {
      return { url: new URL(specifier.slice("typescript/".length), packageRoot).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
