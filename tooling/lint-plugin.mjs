
const listenersFor = (pairs, context) => {
  const listeners = {}
  for (const [selector, message, matches] of pairs) {
    const previous = listeners[selector]
    listeners[selector] = (node) => {
      previous?.(node)
      if (matches !== undefined && !matches(node)) return
      context.report({ node, message })
    }
  }
  return listeners
}

const stringText = (node) =>
  node.type === "TemplateLiteral"
    ? node.quasis.map((quasi) => quasi.value.raw).join("${}")
    : node.value
const textListeners = (pattern, message) => {
  const regex = new RegExp(pattern, "i")
  const matches = (node) => regex.test(stringText(node))
  return [
    ["TemplateLiteral", message, matches],
    ["Literal[value=/./]", message, (node) => typeof node.value === "string" && matches(node)]
  ]
}

const restrictedSyntax = {
  meta: {
    type: "suggestion",
    docs: { description: "Syntax this repo bans, as ESLint selectors (oxlint.config.ts)." },
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          selector: { type: "string" },
          pattern: { type: "string" },
          message: { type: "string" }
        },
        required: ["message"],
        oneOf: [{ required: ["selector"] }, { required: ["pattern"] }],
        additionalProperties: false
      }
    }
  },
  create: (context) =>
    listenersFor(
      context.options.flatMap(({ selector, pattern, message }) =>
        pattern === undefined ? [[selector, message]] : textListeners(pattern, message)
      ),
      context
    )
}

export default {
  meta: { name: "arden" },
  rules: {
    "restricted-syntax": restrictedSyntax,
    "restricted-owner": restrictedSyntax
  }
}
