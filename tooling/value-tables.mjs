const table = (names) => Object.freeze(Object.fromEntries(names.map((name) => [name, name])))

export const ESTREE_NODE = table([
  "ArrowFunctionExpression",
  "BinaryExpression",
  "CallExpression",
  "ExportNamedDeclaration",
  "FunctionDeclaration",
  "FunctionExpression",
  "Identifier",
  "Literal",
  "MemberExpression",
  "ObjectExpression",
  "ParenthesizedExpression",
  "Property",
  "TemplateLiteral",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeQuery",
  "TSTypeAssertion",
  "TSUndefinedKeyword",
  "TSUnionType",
  "UnaryExpression",
  "VariableDeclaration"
])

export const COMMENT_KIND = table(["Block", "Line", "Shebang"])

export const OPERATOR = Object.freeze({
  strictEqual: "===",
  strictNotEqual: "!==",
  minus: "-",
  nullish: "??",
  or: "||",
  typeof: "typeof"
})

export const SYNTAX_NAME = table(["JSON", "Schema", "json", "parse", "platform", "process", "replace"])

export const FLAG = Object.freeze({ on: "1" })

export const ENV_FLAG = Object.freeze({ true: "true" })

export const CI_REF_TYPE = Object.freeze({ tag: "tag" })

export const NPM_ACCESS = Object.freeze({ public: "public" })

export const RELEASE_MODE = table(["version", "publish"])

export const LINT_SCOPE = table(["workspace", "renderer", "server", "frozen"])

export const MODULE_SPECIFIER = Object.freeze({ typescript: "typescript" })

export const SQLITE_CHECK_RESULT = Object.freeze({ ok: "ok" })

export const SQLITE_JOURNAL_MODE = Object.freeze({ delete: "delete" })

export const OS_PLATFORM = Object.freeze({ darwin: "darwin" })

export const MAINTENANCE_COMMAND = Object.freeze({
  storageCheck: "storage check",
  searchRebuild: "search rebuild"
})

export const MAINTENANCE_FLAG = Object.freeze({
  dataRoot: "--data-root",
  confirmStopped: "--confirm-stopped"
})

export const MEMORY_TEST_HALF = table(["sent", "answered"])
