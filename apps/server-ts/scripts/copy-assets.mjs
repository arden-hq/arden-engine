import { copyFileSync, mkdirSync, readdirSync } from "node:fs"

const ASSETS = ["browser/procedures/POMERADO-LICENSE.md"]

for (const asset of ASSETS) {
  const to = new URL(`../dist/${asset}`, import.meta.url)
  mkdirSync(new URL(".", to), { recursive: true })
  copyFileSync(new URL(`../src/${asset}`, import.meta.url), to)
}

function copyMarkdownTree(from, to) {
  mkdirSync(to, { recursive: true })

  for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : Number(a.name > b.name)
  )) {
    const source = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, from)
    const destination = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, to)

    if (entry.isDirectory()) copyMarkdownTree(source, destination)
    else if (entry.isFile() && entry.name.endsWith(".md")) copyFileSync(source, destination)
  }
}

copyMarkdownTree(
  new URL("../src/prompts/authored/", import.meta.url),
  new URL("../dist/prompts/authored/", import.meta.url)
)
