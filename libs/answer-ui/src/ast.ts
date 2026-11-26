import { isRecord } from "@arden-hq/std/json"
import type { ASTNode, ElementNode } from "@openuidev/lang-core"

export const AST_KIND = {
  Comp: "Comp",
  Ref: "Ref",
  StateRef: "StateRef",
  RuntimeRef: "RuntimeRef",
  BinOp: "BinOp",
  UnaryOp: "UnaryOp",
  Ternary: "Ternary",
  Member: "Member",
  Index: "Index",
  Assign: "Assign",
  Str: "Str",
  Num: "Num",
  Bool: "Bool",
  Null: "Null",
  Arr: "Arr",
  Obj: "Obj",
  Ph: "Ph"
} as const satisfies { readonly [K in ASTNode["k"]]: K }
type AstKind = (typeof AST_KIND)[keyof typeof AST_KIND]

const AST_KINDS: ReadonlySet<string> = new Set<AstKind>(Object.values(AST_KIND))

export function isAstNode(value: unknown): value is ASTNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const kind: unknown = Reflect.get(value, "k")
  return typeof kind === "string" && AST_KINDS.has(kind)
}

const ELEMENT_NODE_TYPE = "element" satisfies ElementNode["type"]

export const isElement = (value: unknown): value is ElementNode =>
  isRecord(value) &&
  value["type"] === ELEMENT_NODE_TYPE &&
  typeof value["typeName"] === "string" &&
  isRecord(value["props"])
