import type { ASTNode } from "@openuidev/lang-core"

/** The `k` of every expression node lang-core can leave unevaluated in a
 *  parse result. lang-core 1.x no longer exports its own `isASTNode`. */
const AST_KINDS: ReadonlySet<string> = new Set<ASTNode["k"]>([
  "Comp",
  "Ref",
  "StateRef",
  "RuntimeRef",
  "BinOp",
  "UnaryOp",
  "Ternary",
  "Member",
  "Index",
  "Assign",
  "Str",
  "Num",
  "Bool",
  "Null",
  "Arr",
  "Obj",
  "Ph"
])

export function isAstNode(value: unknown): value is ASTNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const kind: unknown = Reflect.get(value, "k")
  return typeof kind === "string" && AST_KINDS.has(kind)
}
