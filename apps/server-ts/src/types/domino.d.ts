declare module "@mixmark-io/domino" {
  export interface HtmlNode {
    readonly nodeName: string
    textContent: string | null
    readonly parentNode: HtmlNode | null
    readonly firstChild: HtmlNode | null
    querySelector(selectors: string): HtmlNode | null
    querySelectorAll(selectors: string): ArrayLike<HtmlNode>
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
    appendChild(node: HtmlNode): HtmlNode
    removeChild(node: HtmlNode): HtmlNode
    insertBefore(node: HtmlNode, child: HtmlNode | null): HtmlNode
  }

  export interface HtmlDocument {
    readonly title: string
    readonly body: HtmlNode
    querySelector(selectors: string): HtmlNode | null
    querySelectorAll(selectors: string): ArrayLike<HtmlNode>
    createElement(tagName: string): HtmlNode
  }

  export function createDocument(html: string): HtmlDocument
}
