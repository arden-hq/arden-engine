import type { JsonValue } from "@arden-hq/protocol"
import { Predicate } from "effect"

export const readField = (
  context: Readonly<Record<string, JsonValue>>,
  path: string
): JsonValue | undefined =>
  path
    .split(".")
    .reduce<JsonValue | undefined>(
      (value, part) =>
        Predicate.isObject(value) && !Array.isArray(value) && Object.hasOwn(value, part)
          ? value[part]
          : undefined,
      context
    )

export const readText = (
  context: Readonly<Record<string, JsonValue>>,
  path: string
): string | undefined => {
  const value = readField(context, path)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

export const readNumber = (
  context: Readonly<Record<string, JsonValue>>,
  path: string
): number | undefined => {
  const value = readField(context, path)
  return typeof value === "number" ? value : undefined
}

export const readFlag = (context: Readonly<Record<string, JsonValue>>, path: string): boolean =>
  readField(context, path) === true

export const readTexts = (
  context: Readonly<Record<string, JsonValue>>,
  path: string
): ReadonlyArray<string> => {
  const value = readField(context, path)
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : []
}
