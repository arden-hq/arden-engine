import { createDocument, type HtmlNode } from "@mixmark-io/domino"
import TurndownService from "turndown"

const omitted = "head,script,style,noscript,template,iframe,object,svg,canvas"
const blocks = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "HEADER",
  "FOOTER",
  "NAV",
  "ASIDE",
  "TABLE",
  "TR",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR"
])

const LEAD_IMAGE_META = [
  'meta[property="og:image"]',
  'meta[name="og:image"]',
  'meta[property="og:image:url"]',
  'meta[name="twitter:image"]',
  'meta[property="twitter:image"]'
]

const MAX_PAGE_IMAGES = 20

const lastOfSrcset = (srcset: string | null): string | null =>
  srcset
    ?.split(/,\s+/u)
    .map((entry) => entry.trim().split(/\s+/u)[0] ?? "")
    .findLast((address) => address !== "") ?? null

const imageAddress = (node: HtmlNode): string | null => {
  const src = node.getAttribute("src")
  if (src !== null && src.trim() !== "" && !/^data:/iu.test(src.trim())) return src
  return (
    node.getAttribute("data-src") ??
    lastOfSrcset(node.getAttribute("data-srcset")) ??
    lastOfSrcset(node.getAttribute("srcset"))
  )
}

export function readHtml(
  html: string,
  options: { readonly format: "markdown" | "text" | "html"; readonly base?: URL }
): { readonly content: string; readonly title: string | undefined } {
  const document = createDocument(html)
  const title = document.title.replace(/\s+/gu, " ").trim() || undefined
  if (options.format === "html") return { content: html, title }
  const lead = LEAD_IMAGE_META.map((selector) =>
    document.querySelector(selector)?.getAttribute("content")
  ).find((content) => content !== null && content !== undefined && content.trim() !== "")
  for (const node of Array.from(document.querySelectorAll(omitted)))
    node.parentNode?.removeChild(node)
  const absolute = (address: string | null | undefined): string | undefined => {
    if (address === null || address === undefined || address.trim() === "") return undefined
    return URL.parse(address.trim(), options.base?.href)?.toString()
  }
  if (options.base !== undefined) {
    for (const node of Array.from(document.querySelectorAll("a[href]"))) {
      const url = absolute(node.getAttribute("href"))
      if (url !== undefined) node.setAttribute("href", url)
    }
  }
  const shown = new Set<string>()
  for (const node of Array.from(document.querySelectorAll("img"))) {
    const url = absolute(imageAddress(node))
    const pixel = [node.getAttribute("width"), node.getAttribute("height")].some(
      (side) => side !== null && side.trim() !== "" && Number(side) <= 2
    )
    if (
      url === undefined ||
      !/^https:/iu.test(url) ||
      pixel ||
      shown.size >= MAX_PAGE_IMAGES ||
      shown.has(url)
    )
      node.parentNode?.removeChild(node)
    else {
      shown.add(url)
      node.setAttribute("src", url)
    }
  }
  const leadImage = options.format === "markdown" ? absolute(lead) : undefined
  if (leadImage !== undefined && /^https:/iu.test(leadImage) && !shown.has(leadImage)) {
    const image = document.createElement("img")
    image.setAttribute("src", leadImage)
    image.setAttribute("alt", title ?? "")
    document.body.insertBefore(image, document.body.firstChild)
  }
  // Normalize bare/whitespace-prefixed pre blocks to Turndown's fenced-code rule.
  for (const node of Array.from(document.querySelectorAll("pre"))) {
    const code = document.createElement("code")
    const language = node.querySelector("code")?.getAttribute("class")
    if (language) code.setAttribute("class", language)
    code.textContent = node.textContent
    node.textContent = ""
    node.appendChild(code)
  }
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
    preformattedCode: true
  })
  if (options.format === "text") {
    converter.escape = (text) => text
    converter.addRule("plain-text", {
      filter: () => true,
      replacement: (content, node: HtmlNode) => {
        if (node.nodeName === "PRE") return `\n\n${node.textContent}\n\n`
        if (node.nodeName === "BR") return "\n"
        if (node.nodeName === "TD" || node.nodeName === "TH") return `${content}\t`
        return blocks.has(node.nodeName) ? `\n\n${content}\n\n` : content
      }
    })
  }
  return { content: converter.turndown(document.body), title }
}
