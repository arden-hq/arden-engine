import {
  AUTOMATION_CONDITION,
  CONDITION_OPERATOR,
  type AutomationComparisonCondition,
  type AutomationCondition,
  type AutomationEventDefinition
} from "@arden-hq/protocol/automations"
import type { JsonValue } from "@arden-hq/protocol"

type EventContext = Readonly<Record<string, JsonValue>>

export const conditionIssue = (
  entry: AutomationEventDefinition,
  condition: AutomationCondition
): string | null => {
  switch (condition.kind) {
    case AUTOMATION_CONDITION.and:
    case AUTOMATION_CONDITION.or: {
      for (const child of condition.conditions) {
        const issue = conditionIssue(entry, child)
        if (issue !== null) return issue
      }
      return null
    }
    case AUTOMATION_CONDITION.not:
      return conditionIssue(entry, condition.condition)
    case AUTOMATION_CONDITION.compare: {
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
  condition: AutomationComparisonCondition
): boolean => {
  if (condition.op === CONDITION_OPERATOR.exists) return actual !== undefined && actual !== null
  if (actual === undefined) return false
  if (condition.op === CONDITION_OPERATOR.in)
    return condition.value.some((candidate) => jsonEqual(actual, candidate))
  const expected = condition.value
  switch (condition.op) {
    case CONDITION_OPERATOR.eq:
      return jsonEqual(actual, expected)
    case CONDITION_OPERATOR.ne:
      return !jsonEqual(actual, expected)
    case CONDITION_OPERATOR.gt:
      return typeof actual === "number" && typeof expected === "number" && actual > expected
    case CONDITION_OPERATOR.gte:
      return typeof actual === "number" && typeof expected === "number" && actual >= expected
    case CONDITION_OPERATOR.lt:
      return typeof actual === "number" && typeof expected === "number" && actual < expected
    case CONDITION_OPERATOR.lte:
      return typeof actual === "number" && typeof expected === "number" && actual <= expected
    case CONDITION_OPERATOR.contains:
      return contains(actual, expected)
    case CONDITION_OPERATOR.starts_with:
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLocaleLowerCase().startsWith(expected.toLocaleLowerCase())
      )
    case CONDITION_OPERATOR.ends_with:
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLocaleLowerCase().endsWith(expected.toLocaleLowerCase())
      )
  }
}

export const conditionMatches = (
  condition: AutomationCondition,
  context: EventContext
): boolean => {
  switch (condition.kind) {
    case AUTOMATION_CONDITION.and:
      return condition.conditions.every((child) => conditionMatches(child, context))
    case AUTOMATION_CONDITION.or:
      return condition.conditions.some((child) => conditionMatches(child, context))
    case AUTOMATION_CONDITION.not:
      return !conditionMatches(condition.condition, context)
    case AUTOMATION_CONDITION.compare:
      return compare(readField(context, condition.field), condition)
  }
}
