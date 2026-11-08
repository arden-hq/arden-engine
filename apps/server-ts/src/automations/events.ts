import type {
  AutomationCondition,
  AutomationConditionOperator,
  AutomationEventDefinition
} from "@arden-hq/protocol/automations"
import type { JsonValue } from "@arden-hq/protocol"

type EventContext = Readonly<Record<string, JsonValue>>

export const conditionIssue = (
  entry: AutomationEventDefinition,
  condition: AutomationCondition
): string | null => {
  switch (condition.kind) {
    case "and":
    case "or": {
      for (const child of condition.conditions) {
        const issue = conditionIssue(entry, child)
        if (issue !== null) return issue
      }
      return null
    }
    case "not":
      return conditionIssue(entry, condition.condition)
    case "compare": {
      const field = entry.fields.find((candidate) => candidate.field === condition.field)
      if (field === undefined)
        return `Unknown ${entry.event_type} condition field: ${condition.field}`
      if (!field.operators.some((operator) => operator === condition.op)) {
        return `Operator ${condition.op} is not valid for ${condition.field}`
      }
      return null
    }
  }
}

const isJsonArray = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value)

const objectValue = (value: JsonValue): Readonly<Record<string, JsonValue>> | null =>
  typeof value === "object" && value !== null && !isJsonArray(value) ? value : null

export const readField = (context: EventContext, path: string): JsonValue | undefined => {
  const parts = path.split(".")
  let value: JsonValue = context
  for (const part of parts) {
    const object = objectValue(value)
    const next = object === null || !Object.hasOwn(object, part) ? undefined : object[part]
    if (next === undefined) return undefined
    value = next
  }
  return value
}

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true
  if (isJsonArray(left) || isJsonArray(right)) {
    return (
      isJsonArray(left) &&
      isJsonArray(right) &&
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index]
        return other !== undefined && jsonEqual(value, other)
      })
    )
  }
  const leftObject = objectValue(left)
  const rightObject = objectValue(right)
  if (leftObject === null || rightObject === null) return false
  return (
    Object.keys(leftObject).length === Object.keys(rightObject).length &&
    Object.entries(leftObject).every(([key, value]) => {
      const other = Object.hasOwn(rightObject, key) ? rightObject[key] : undefined
      return other !== undefined && jsonEqual(value, other)
    })
  )
}

const contains = (container: JsonValue, value: JsonValue): boolean => {
  if (typeof container === "string" && typeof value === "string") {
    return container.toLocaleLowerCase().includes(value.toLocaleLowerCase())
  }
  return (
    Array.isArray(container) &&
    container.some(
      (candidate) =>
        jsonEqual(candidate, value) ||
        (typeof candidate === "string" &&
          typeof value === "string" &&
          candidate.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    )
  )
}

const compare = (
  actual: JsonValue | undefined,
  operator: AutomationConditionOperator,
  expected: JsonValue | undefined
): boolean => {
  if (operator === "exists") return actual !== undefined && actual !== null
  if (actual === undefined || expected === undefined) return false
  switch (operator) {
    case "eq":
      return jsonEqual(actual, expected)
    case "ne":
      return !jsonEqual(actual, expected)
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected
    case "contains":
      return contains(actual, expected)
    case "starts_with":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLocaleLowerCase().startsWith(expected.toLocaleLowerCase())
      )
    case "ends_with":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLocaleLowerCase().endsWith(expected.toLocaleLowerCase())
      )
    case "in":
      return Array.isArray(expected) && expected.some((candidate) => jsonEqual(actual, candidate))
  }
}

export const conditionMatches = (
  condition: AutomationCondition | null | undefined,
  context: EventContext
): boolean => {
  if (condition === null || condition === undefined) return true
  switch (condition.kind) {
    case "and":
      return condition.conditions.every((child) => conditionMatches(child, context))
    case "or":
      return condition.conditions.some((child) => conditionMatches(child, context))
    case "not":
      return !conditionMatches(condition.condition, context)
    case "compare":
      return compare(readField(context, condition.field), condition.op, condition.value)
  }
}
