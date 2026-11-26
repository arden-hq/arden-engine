export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const compareCodePoints = (left: string, right: string): number => {
  let leftIndex = 0
  let rightIndex = 0
  for (;;) {
    const leftPoint = left.codePointAt(leftIndex)
    const rightPoint = right.codePointAt(rightIndex)
    if (leftPoint === undefined) return rightPoint === undefined ? 0 : -1
    if (rightPoint === undefined) return 1
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
}

export const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const sortedEntries = (value: object): Array<[string, unknown]> =>
  Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => [key, Reflect.get(value, key)])

const strictJson = (value: unknown): string => {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite")
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) return `[${value.map(strictJson).join(",")}]`
      if (!isPlainObject(value)) throw new TypeError("Value is not a JSON object")
      return `{${sortedEntries(value)
        .map(([key, entry]) => `${JSON.stringify(key)}:${strictJson(entry)}`)
        .join(",")}}`
    }
    case "bigint":
    case "symbol":
    case "undefined":
    case "function":
      break
  }
  throw new TypeError("Value is not JSON-serializable")
}

const lenientJson = (value: unknown, key: string): string | undefined => {
  const item =
    typeof value === "object" &&
    value !== null &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
      ? (value.toJSON(key) as unknown)
      : value
  switch (typeof item) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(item)
    case "undefined":
    case "function":
    case "symbol":
      return undefined
    case "bigint":
      throw new TypeError("BigInt is not JSON-serializable")
    case "object":
      break
  }
  if (item === null) return "null"
  if (Array.isArray(item)) {
    return `[${item.map((entry, index) => lenientJson(entry, String(index)) ?? "null").join(",")}]`
  }
  const members: string[] = []
  for (const [name, entry] of sortedEntries(item)) {
    const encoded = lenientJson(entry, name)
    if (encoded !== undefined) members.push(`${JSON.stringify(name)}:${encoded}`)
  }
  return `{${members.join(",")}}`
}

export const canonicalJson = (
  value: unknown,
  options: { readonly lenient?: boolean } = {}
): string => {
  if (options.lenient !== true) return strictJson(value)
  const encoded = lenientJson(value, "")
  if (encoded === undefined) throw new TypeError("Value is not JSON-serializable")
  return encoded
}

export const engineOrderedJson = (value: unknown): string => {
  const encoded: string | undefined = JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
  if (encoded === undefined) throw new TypeError("Value is not JSON-serializable")
  return encoded
}

export const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  )
}
