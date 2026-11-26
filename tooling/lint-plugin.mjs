import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const countAll = process.env.ARDEN_BASELINE_COUNT === "1"

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

const scriptFile = /\.(?:js|mjs|cjs)$/
const typeTag = /^@(?:type|typedef|param|returns?|template|satisfies|import|property|prop|callback|overload|this|enum|extends|implements)\b/
const citesSource = /https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])\S+|\b[\w.-]+\/[\w.-]+#\d+\b|\bcrbug\s+\d+|\bRFC\s?\d+\b/
const licenseHeader = /^(?:\*\s*)?(?:@license|SPDX-License-Identifier:|Copyright\b)/
const formatterIgnore = /^(?:prettier|oxfmt)-ignore\b/

const allowedComment = (comment, filename) => {
  const text = comment.value.trim()
  if (citesSource.test(text) || licenseHeader.test(text) || formatterIgnore.test(text)) return true
  if (/^(?:oxlint|eslint)-(?:disable|enable)\S*\s.*\s--\s+\S/.test(text)) return true
  if (/^@ts-expect-error\s+\S/.test(text)) return true
  if (comment.type === "Line" && /^\/\s*<reference(?:\s+(?:types|path|lib|no-default-lib|preserve|resolution-mode)=(["'])[^"']*\1)+\s*\/>\s*$/.test(comment.value)) return true
  if (comment.type !== "Block" || !comment.value.startsWith("*") || !scriptFile.test(filename)) return false
  const lines = comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .filter((line) => line !== "")
  let depth = 0
  for (const line of lines) {
    if (depth === 0 && !typeTag.test(line)) return false
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }
  return lines.length > 0
}

const noCommentsMessage =
  "No comments in code: put the reason in the commit message or the PR. Allowed: a comment that cites its source (an issue, RFC or vendor link) for a constraint code cannot express, a license header, `prettier-ignore`, `oxlint-disable… -- reason`, `@ts-expect-error reason`, and JSDoc type tags in .js/.mjs/.cjs files"
const noStringCompareMessage =
  "Compare with a named constant from the value's owner (an `as const` list or object, or its type guard), not a bare string"

const unwrap = (node) =>
  ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"].includes(node.type)
    ? unwrap(node.expression)
    : node
const isStringLiteral = (wrapped) => {
  const node = unwrap(wrapped)
  return (
    (node.type === "Literal" && typeof node.value === "string" && node.value !== "") ||
    (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis[0].value.cooked !== "")
  )
}
const isTypeof = (wrapped) => {
  const node = unwrap(wrapped)
  return node.type === "UnaryExpression" && node.operator === "typeof"
}
const compareOperators = new Set(["===", "!==", "==", "!="])
const timingCalls = new Set(["useEffect", "useLayoutEffect", "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback"])
const timingHosts = new Set(["window", "globalThis", "self", "React"])
const memberName = (member) => {
  if (!member.computed) return member.property.name
  const property = unwrap(member.property)
  return property.type === "Literal" && typeof property.value === "string" ? property.value : undefined
}
const isTimingCall = (callee, aliases) =>
  (callee.type === "Identifier" && (timingCalls.has(callee.name) || aliases.has(callee.name))) ||
  (callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    timingHosts.has(callee.object.name) &&
    timingCalls.has(memberName(callee)))
const sources = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}"
const testFiles = [`**/{test,tests}/**/*.${sources}`, `**/*.test.${sources}`]

const idName = /(^id$|Id$|_id$|^ref$|Ref$)/
const sqlId = String.raw`(?:[\w.]*_(?:id|ref)\b|\$\{[^}]*(?:Id|Ref|Key|_id|_ref)\b[^}]*\})`
const sqlIdReads = [
  new RegExp(String.raw`\b(?:substr|instr)\(\s*` + sqlId, "i"),
  new RegExp(sqlId + String.raw`\s+(?:NOT\s+)?(?:LIKE|GLOB)\s+(?:'[^'%*]*[^'%*\s][%*]'|\$\{[^}]*\}\s*\|\|\s*'[%*]')`, "i"),
  new RegExp(String.raw`\|\|\s*'[^'\s]*[:~]'\s*\)?\s*(?:AND|OR|$|\))`, "i"),
  new RegExp(sqlId + String.raw`\s*[<>]=?\s*\$\{[^}]*(?:prefix|Prefix)[^}]*\}`, "i")
]
const idEdges = [
  "apps/server-ts/src/computer/bundle-id.ts",
  "apps/server-ts/src/persistence/managed-output/ref.ts",
  "apps/server-ts/src/tools/google-gmail-refs.ts",
  "libs/protocol/src/skills/marketplace-id.ts",
  "libs/loop/src/providers/openai-responses/output-id.ts",
  "apps/server-ts/src/mcp/own-request-id.ts",
  "apps/server-ts/src/persistence/chat/workflow-delivery.ts",
  "apps/server-ts/src/persistence/migrations/**"
]
const idLikeName = /(^id$|Id$|_id$|^ref$|Ref$|^key$|Key$|^index$|Index$)/
const objectName = (node) => {
  const target = unwrap(node)
  if (target.type === "Identifier") return target.name
  if (target.type === "MemberExpression" && !target.computed) return target.property.name
  return undefined
}
const isNumberLiteral = (wrapped) => {
  const node = unwrap(wrapped)
  return node.type === "Literal" && typeof node.value === "number"
}
const cutsToLength = (method, args) =>
  ["slice", "substring", "substr"].includes(method) &&
  args.length === 2 &&
  isNumberLiteral(args[0]) &&
  unwrap(args[0]).value === 0 &&
  isNumberLiteral(args[1])
const cleansCharacters = (method, args) => {
  const pattern = args.length === 2 ? unwrap(args[0]) : undefined
  return method === "replace" && pattern?.type === "Literal" && pattern.regex?.flags.includes("g") === true
}
const idMethods = new Set(["startsWith", "endsWith", "split", "slice", "substring", "substr", "indexOf", "lastIndexOf", "match", "replace"])
const isMadeUpDefault = (node) => {
  const right = unwrap(node.right)
  const name = objectName(node.left)
  if (name === undefined || !idLikeName.test(name)) return false
  return (
    (right.type === "Literal" && (right.value === "" || right.value === 0)) ||
    (right.type === "TemplateLiteral" && right.expressions.length === 0 && right.quasis[0].value.cooked === "") ||
    (right.type === "UnaryExpression" && right.operator === "-" && right.argument.type === "Literal" && right.argument.value === 1)
  )
}
const isFunction = (node) => node !== null && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression")
const testEscapes = new Set(["only", "skip", "todo", "skipIf", "runIf", "fails", "failing", "if"])
const testNames = new Set(["it", "test", "describe", "suite", "bench"])
const testRoot = (node) => {
  const target = unwrap(node)
  if (target.type === "Identifier") return testNames.has(target.name)
  if (target.type === "MemberExpression") return testRoot(target.object)
  if (target.type === "CallExpression") return testRoot(target.callee)
  return false
}
const platformGates = new Set(["skipIf", "runIf"])
const isProcessPlatform = (wrapped) => {
  const node = unwrap(wrapped)
  return node.type === "MemberExpression" && !node.computed && objectName(node.object) === "process" && node.property.name === "platform"
}
const isPlatformCheck = (wrapped) => {
  const node = unwrap(wrapped)
  if (node.type !== "BinaryExpression" || (node.operator !== "===" && node.operator !== "!==")) return false
  return (isProcessPlatform(node.left) && isStringLiteral(node.right)) || (isProcessPlatform(node.right) && isStringLiteral(node.left))
}
const isPlatformGate = (node) => {
  const call = node.parent
  return (
    platformGates.has(memberName(node)) &&
    call?.type === "CallExpression" &&
    call.callee === node &&
    call.arguments.length === 1 &&
    isPlatformCheck(call.arguments[0])
  )
}
const longFileLines = 500
const allowsUndefined = (node) => {
  const annotation = node.typeAnnotation?.typeAnnotation
  return annotation?.type === "TSUnionType" && annotation.types.some((member) => member.type === "TSUndefinedKeyword")
}
const optionalSchemas = new Set(["optional", "optionalKey", "optionalWith", "NullOr", "UndefinedOr"])

export const baselinedRules = [
  {
    rule: "no-comments",
    files: [`**/*.${sources}`],
    ignores: [],
    baseline: "tooling/baselines/comments.json",
    message: noCommentsMessage,
    description: "No comments in code.",
    collect: (context, found) => ({
      "Program:exit": () => {
        const path = relative(repoRoot, resolve(context.filename))
        for (const comment of context.sourceCode.getAllComments())
          if (!allowedComment(comment, path)) found.push({ loc: comment.loc })
      }
    })
  },
  {
    rule: "no-string-compare",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: testFiles,
    baseline: "tooling/baselines/string-compares.json",
    message: noStringCompareMessage,
    description: "No compares against a bare string.",
    collect: (_context, found) => ({
      BinaryExpression: (node) => {
        if (!compareOperators.has(node.operator)) return
        const [literal, other] = isStringLiteral(node.right) ? [node.right, node.left] : [node.left, node.right]
        if (isStringLiteral(literal) && !isTypeof(other)) found.push({ node })
      },
      SwitchStatement: (node) => {
        if (isTypeof(node.discriminant)) return
        for (const branch of node.cases) if (branch.test !== null && isStringLiteral(branch.test)) found.push({ node: branch.test })
      }
    })
  },
  {
    rule: "no-raw-timing",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: ["libs/std/src/**", ...testFiles],
    baseline: "tooling/baselines/raw-timing.json",
    message: "Raw timers and effects live only in @arden-hq/std (libs/std/src). Use its helpers, such as sleep, or add one there",
    description: "No useEffect or raw timer outside the helper folders.",
    collect: (_context, found) => {
      const aliases = new Set()
      return {
        ImportSpecifier: (node) => {
          const imported = node.imported.type === "Identifier" ? node.imported.name : node.imported.value
          if (timingCalls.has(imported)) aliases.add(node.local.name)
        },
        CallExpression: (node) => {
          if (isTimingCall(node.callee, aliases)) found.push({ node: node.callee })
        }
      }
    }
  },
  {
    rule: "no-raw-json",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: ["apps/server-ts/src/persistence/sqlite/json.ts", "libs/std/src/json-text.ts", ...testFiles],
    baseline: "tooling/baselines/raw-json.json",
    message: "Outside data is decoded once, at the edge, with a Schema: decodeJson (persistence/sqlite/json.ts) or Schema.decodeUnknownSync(Schema.fromJsonString(schema))",
    description: "Outside data is parsed once, at the edge.",
    collect: (_context, found) => ({
      CallExpression: (node) => {
        const callee = node.callee
        if (callee.type !== "MemberExpression") return
        const isParse = objectName(callee.object) === "JSON" && memberName(callee) === "parse"
        const isBodyJson = memberName(callee) === "json" && node.arguments.length === 0
        if (isParse || isBodyJson) found.push({ node })
      }
    })
  },
  {
    rule: "no-id-parsing",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: idEdges,
    baseline: "tooling/baselines/id-parsing.json",
    message: "Ids carry no meaning: never read a prefix or a part out of an id or ref. Keep the fact in its own typed field",
    description: "No reading parts out of ids.",
    collect: (context, found) => ({
      CallExpression: (node) => {
        const callee = node.callee
        if (callee.type !== "MemberExpression" || callee.computed || !idMethods.has(callee.property.name)) return
        if (cutsToLength(callee.property.name, node.arguments) || cleansCharacters(callee.property.name, node.arguments)) return
        const name = objectName(callee.object)
        if (name !== undefined && idName.test(name)) found.push({ node })
      },
      TemplateLiteral: (node) => {
        const text = node.quasis
          .map((quasi, index) =>
            index < node.expressions.length ? `${quasi.value.raw}\${${context.sourceCode.getText(node.expressions[index])}}` : quasi.value.raw
          )
          .join("")
        if (sqlIdReads.some((pattern) => pattern.test(text))) found.push({ node })
      }
    })
  },
  {
    rule: "no-made-up-default",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: [],
    baseline: "tooling/baselines/made-up-defaults.json",
    message: "Don't invent an id, key or index for missing data (`id ?? ''`, `index ?? -1`): handle the missing case, or make the field required",
    description: "No invented fallbacks.",
    collect: (_context, found) => ({
      LogicalExpression: (node) => {
        if ((node.operator === "??" || node.operator === "||") && isMadeUpDefault(node)) found.push({ node })
      }
    })
  },
  {
    rule: "no-optional-shared-field",
    files: [`libs/protocol/src/**/*.${sources}`],
    ignores: [],
    baseline: "tooling/baselines/optional-fields.json",
    message: "Shared types have no optional fields: give each state its own shape in a union with one tag, so a missing field can't mean two things",
    description: "No optional fields in shared types.",
    collect: (_context, found) => {
      let exported = 0
      let declaring = 0
      return {
        ExportNamedDeclaration: () => {
          exported += 1
        },
        "ExportNamedDeclaration:exit": () => {
          exported -= 1
        },
        TSTypeAliasDeclaration: () => {
          declaring += 1
        },
        "TSTypeAliasDeclaration:exit": () => {
          declaring -= 1
        },
        TSInterfaceDeclaration: () => {
          declaring += 1
        },
        "TSInterfaceDeclaration:exit": () => {
          declaring -= 1
        },
        TSPropertySignature: (node) => {
          if ((exported > 0 || declaring > 0) && (node.optional || allowsUndefined(node))) found.push({ node })
        },
        CallExpression: (node) => {
          const callee = node.callee
          if (callee.type === "MemberExpression" && objectName(callee.object) === "Schema" && optionalSchemas.has(memberName(callee))) found.push({ node })
        }
      }
    }
  },
  {
    rule: "no-import-star",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: [],
    baseline: "tooling/baselines/import-star.json",
    message: "Import the names you use, not the whole module (`import * as`)",
    description: "No namespace imports.",
    collect: (_context, found) => ({
      ImportNamespaceSpecifier: (node) => {
        found.push({ node })
      }
    })
  },
  {
    rule: "no-untyped-export",
    files: [`apps/*/src/**/*.{ts,tsx,mts,cts}`, `libs/*/src/**/*.{ts,tsx,mts,cts}`],
    ignores: [],
    baseline: "tooling/baselines/untyped-exports.json",
    message: "An exported function states its return type",
    description: "Exported functions declare return types.",
    collect: (_context, found) => ({
      ExportDefaultDeclaration: (node) => {
        const declaration = node.declaration
        if ((declaration.type === "FunctionDeclaration" || isFunction(declaration)) && declaration.returnType == null) found.push({ node: declaration })
      },
      ExportNamedDeclaration: (node) => {
        const declaration = node.declaration
        if (declaration === null) return
        if (declaration.type === "FunctionDeclaration" && declaration.returnType == null) found.push({ node: declaration.id ?? declaration })
        if (declaration.type !== "VariableDeclaration") return
        for (const declarator of declaration.declarations)
          if (isFunction(declarator.init) && declarator.init.returnType == null && declarator.id.typeAnnotation == null) found.push({ node: declarator.id })
      }
    })
  },
  {
    rule: "no-long-file",
    files: [`apps/*/src/**/*.${sources}`, `libs/*/src/**/*.${sources}`],
    ignores: [],
    baseline: "tooling/baselines/long-files.json",
    message: `A file stays under ${longFileLines} non-blank lines, one report per extra line: split it by responsibility (the hard limit is 800)`,
    description: "Files stay under 500 lines.",
    collect: (context, found) => ({
      "Program:exit": (node) => {
        const extra = context.sourceCode.lines.filter((line) => line.trim() !== "").length - longFileLines
        for (let line = 0; line < extra; line += 1) found.push({ node, loc: { line: 1, column: 0 } })
      }
    })
  },
  {
    rule: "no-test-escape",
    files: testFiles,
    ignores: [],
    baseline: "tooling/baselines/test-escapes.json",
    message: "No skipped, focused or retried tests: fix the cause, or delete the test and say why in the commit. Only a test of a platform-only feature may gate on `process.platform === \"<os>\"` (skipIf or runIf)",
    description: "No test escape hatches.",
    collect: (_context, found) => ({
      MemberExpression: (node) => {
        if (testEscapes.has(memberName(node)) && testRoot(node.object) && !isPlatformGate(node)) found.push({ node })
      },
      CallExpression: (node) => {
        if (!testRoot(node.callee)) return
        for (const argument of node.arguments)
          if (argument.type === "ObjectExpression")
            for (const property of argument.properties)
              if (property.type === "Property" && ["retry", "repeats"].includes(property.key.type === "Identifier" ? property.key.name : property.key.value)) found.push({ node: property })
      }
    })
  }
]

export const baselinedOverrides = baselinedRules.flatMap(({ rule, files, ignores }) => [
  { files, rules: { [`arden/${rule}`]: "error" } },
  ...(ignores.length === 0 ? [] : [{ files: ignores, rules: { [`arden/${rule}`]: "off" } }])
])

const baselinedRule = ({ baseline, message, description, collect }) => {
  const counts = JSON.parse(readFileSync(resolve(repoRoot, baseline), "utf8"))
  return {
    meta: { type: "suggestion", docs: { description: `${description} Old cases stay in ${baseline} until removed.` } },
    create: (context) => {
      const found = []
      const listeners = collect(context, found)
      const collectExit = listeners["Program:exit"]
      return {
        ...listeners,
        "Program:exit": (node) => {
          collectExit?.(node)
          const path = relative(repoRoot, resolve(context.filename))
          const allowed = countAll || typeof counts[path] !== "number" ? 0 : counts[path]
          if (found.length <= allowed) return
          const text = allowed === 0 ? message : `${message} (this file's baseline is ${allowed}: ${baseline})`
          for (const place of found.slice(allowed)) context.report({ ...place, message: text })
        }
      }
    }
  }
}

export default {
  meta: { name: "arden" },
  rules: {
    "restricted-syntax": restrictedSyntax,
    "restricted-owner": restrictedSyntax,
    ...Object.fromEntries(baselinedRules.map((row) => [row.rule, baselinedRule(row)]))
  }
}
