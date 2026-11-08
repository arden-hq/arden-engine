import type { JsonValue } from "@arden-hq/protocol"

export const joinPromptSections = (
  sections: ReadonlyArray<string | undefined>
): string | undefined => {
  const present = sections.flatMap((section) => {
    if (section === undefined) return []
    const trimmed = section.trim()
    return trimmed === "" ? [] : [trimmed]
  })
  return present.length === 0 ? undefined : present.join("\n\n")
}

export const renderPromptSection = (heading: string, body: string): string =>
  `## ${heading}\n\n${body.trim()}`

export const markdownValue = (value: JsonValue, indent = ""): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}None.`
    return value.map((entry) => bullet(undefined, entry, indent)).join("\n")
  }
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
    if (fields.length === 0) return `${indent}None.`
    return fields.map(([name, entry]) => bullet(name, entry, indent)).join("\n")
  }
  return scalar(value)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n")
}

const bullet = (name: string | undefined, value: JsonValue, indent: string): string => {
  const label = name === undefined ? "" : `${name}:`
  if (value !== null && typeof value === "object")
    return `${indent}-${label === "" ? "" : ` ${label}`}\n${markdownValue(value, `${indent}  `)}`
  const [first, ...rest] = scalar(value).split("\n")
  return [
    `${indent}- ${label === "" ? "" : `${label} `}${first ?? ""}`,
    ...rest.map((line) => `${indent}  ${line}`)
  ].join("\n")
}

const scalar = (value: string | number | boolean | null): string =>
  value === null ? "none" : String(value)
