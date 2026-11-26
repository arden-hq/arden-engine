import { createRequire, registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { MODULE_SPECIFIER } from "./value-tables.mjs"

const rootTypescriptMain = createRequire(import.meta.url).resolve("typescript")
const rootTypescriptPackage = new URL("./", pathToFileURL(createRequire(import.meta.url).resolve("typescript/package.json")))

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === MODULE_SPECIFIER.typescript) return { url: pathToFileURL(rootTypescriptMain).href, shortCircuit: true }
    if (specifier.startsWith("typescript/")) {
      return { url: new URL(specifier.slice("typescript/".length), rootTypescriptPackage).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
