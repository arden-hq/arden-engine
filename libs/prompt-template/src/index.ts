export type PromptTemplateErrorReason =
  | "duplicate_value"
  | "empty_slot"
  | "extra_value"
  | "invalid_template"
  | "invalid_value"
  | "malformed_slot"
  | "missing_value"
  | "nested_slot"
  | "unresolved_value"
  | "unmatched_closing_delimiter"
  | "unmatched_opening_delimiter"

export interface PromptTemplateLocation {
  /** Zero-based UTF-8 byte offset, matching source-file diagnostics. */
  readonly byteOffset: number
  /** One-based line in the LF-normalized source. */
  readonly line: number
  /** One-based Unicode code-point column. */
  readonly column: number
}

export interface PromptTemplateErrorOptions {
  readonly reason: PromptTemplateErrorReason
  readonly message: string
  readonly location?: PromptTemplateLocation
}

export class PromptTemplateError extends Error {
  readonly reason: PromptTemplateErrorReason
  readonly location: PromptTemplateLocation | undefined

  constructor({ reason, message, location }: PromptTemplateErrorOptions) {
    super(message)
    this.name = "PromptTemplateError"
    this.reason = reason
    this.location = location
  }
}

type PromptTemplateToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "slot"; readonly name: string }

interface CompiledPromptTemplate {
  readonly tokens: readonly PromptTemplateToken[]
  readonly slotSet: ReadonlySet<string>
}

export interface PromptTemplate {
  /** Source normalized to LF before parsing. */
  readonly source: string
  /** Unique slot names in first-use order. */
  readonly slots: readonly string[]
}

export interface CompilePromptTemplateOptions {
  readonly source: string
}

export interface RenderPromptTemplateOptions {
  readonly template: PromptTemplate
  readonly values: Readonly<Record<string, string | undefined>>
}

export interface RenderPromptTemplateEntriesOptions {
  readonly template: PromptTemplate
  readonly values: Iterable<readonly [name: string, value: string | undefined]>
}

const compiledTemplates = new WeakMap<PromptTemplate, CompiledPromptTemplate>()

/** Parse a static prompt definition. `{{{{` and `}}}}` produce literal delimiters. */
export const compilePromptTemplate = ({ source }: CompilePromptTemplateOptions): PromptTemplate => {
  const normalizedSource = normalizeLf(source)
  const tokens: PromptTemplateToken[] = []
  const slots: string[] = []
  const seenSlots = new Set<string>()
  let literalStart = 0
  let cursor = 0

  while (cursor < normalizedSource.length) {
    if (normalizedSource.startsWith("{{{{", cursor)) {
      appendText(tokens, normalizedSource.slice(literalStart, cursor))
      appendText(tokens, "{{")
      cursor += 4
      literalStart = cursor
      continue
    }
    if (normalizedSource.startsWith("}}}}", cursor)) {
      appendText(tokens, normalizedSource.slice(literalStart, cursor))
      appendText(tokens, "}}")
      cursor += 4
      literalStart = cursor
      continue
    }
    if (normalizedSource.startsWith("{{", cursor)) {
      appendText(tokens, normalizedSource.slice(literalStart, cursor))
      const slot = parseSlot(normalizedSource, cursor)
      if (!seenSlots.has(slot.name)) {
        seenSlots.add(slot.name)
        slots.push(slot.name)
      }
      tokens.push(Object.freeze({ kind: "slot", name: slot.name }))
      cursor = slot.nextCursor
      literalStart = cursor
      continue
    }
    if (normalizedSource.startsWith("}}", cursor)) {
      throw templateErrorAt(
        "unmatched_closing_delimiter",
        "Unmatched '}}' in prompt template",
        normalizedSource,
        cursor
      )
    }
    cursor += codePointWidthAt(normalizedSource, cursor)
  }

  appendText(tokens, normalizedSource.slice(literalStart))
  const template = Object.freeze({
    source: normalizedSource,
    slots: Object.freeze(slots)
  })
  compiledTemplates.set(
    template,
    Object.freeze({
      tokens: Object.freeze(tokens),
      slotSet: new Set(slots)
    })
  )
  return template
}

/** Render exactly the slots declared by a compiled prompt, once and without evaluation. */
export const renderPromptTemplate = ({ template, values }: RenderPromptTemplateOptions): string =>
  renderPromptTemplateEntries({ template, values: Object.entries(values) })

/** Iterable form preserves duplicate keys so boundary adapters can reject them. */
export const renderPromptTemplateEntries = ({
  template,
  values
}: RenderPromptTemplateEntriesOptions): string => {
  const compiled = compiledTemplates.get(template)
  if (compiled === undefined) {
    throw templateError(
      "invalid_template",
      "Prompt template was not created by compilePromptTemplate."
    )
  }

  const resolved = new Map<string, string>()
  for (const [name, value] of values) {
    if (resolved.has(name)) {
      throw templateError("duplicate_value", `Prompt template received '${name}' more than once.`)
    }
    if (value === undefined) {
      throw templateError("unresolved_value", `Prompt template value '${name}' is unresolved.`)
    }
    if (typeof value !== "string") {
      throw templateError("invalid_value", `Prompt template value '${name}' must be a string.`)
    }
    resolved.set(name, value)
  }

  for (const name of template.slots) {
    if (!resolved.has(name)) {
      throw templateError("missing_value", `Prompt template is missing a value for '${name}'.`)
    }
  }
  for (const name of resolved.keys()) {
    if (!compiled.slotSet.has(name)) {
      throw templateError("extra_value", `Prompt template received no slot named '${name}'.`)
    }
  }

  return compiled.tokens
    .map((token) => {
      if (token.kind === "text") return token.value
      const value = resolved.get(token.name)
      if (value === undefined) {
        throw templateError(
          "missing_value",
          `Prompt template is missing a value for '${token.name}'.`
        )
      }
      return value
    })
    .join("")
}

const appendText = (tokens: PromptTemplateToken[], value: string): void => {
  if (value.length === 0) return
  const previous = tokens.at(-1)
  if (previous?.kind === "text") {
    tokens[tokens.length - 1] = Object.freeze({ kind: "text", value: previous.value + value })
    return
  }
  tokens.push(Object.freeze({ kind: "text", value }))
}

const parseSlot = (
  source: string,
  start: number
): { readonly name: string; readonly nextCursor: number } => {
  const declarationStart = start + 2
  let cursor = declarationStart

  while (cursor < source.length) {
    if (source.startsWith("{{", cursor)) {
      throw templateErrorAt("nested_slot", "Prompt template slots cannot be nested", source, start)
    }
    if (source.startsWith("}}", cursor)) {
      const declaration = source.slice(declarationStart, cursor)
      const name = declaration.trim()
      if (name.length === 0) {
        throw templateErrorAt("empty_slot", "Prompt template slots must have a name", source, start)
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw templateErrorAt(
          "malformed_slot",
          `Invalid prompt template slot '${declaration}'`,
          source,
          start
        )
      }
      return Object.freeze({ name, nextCursor: cursor + 2 })
    }
    cursor += codePointWidthAt(source, cursor)
  }

  throw templateErrorAt(
    "unmatched_opening_delimiter",
    "Unmatched '{{' in prompt template",
    source,
    start
  )
}

const sourceLocation = (source: string, index: number): PromptTemplateLocation => {
  const prefix = source.slice(0, index)
  const lineStart = prefix.lastIndexOf("\n") + 1
  return Object.freeze({
    byteOffset: utf8ByteLength(prefix),
    line: prefix.split("\n").length,
    column: Array.from(source.slice(lineStart, index)).length + 1
  })
}

const codePointWidthAt = (source: string, index: number): number =>
  (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1

const normalizeLf = (value: string): string => value.replace(/\r\n?/g, "\n")

const utf8Width = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  return codePoint <= 0xffff ? 3 : 4
}

const utf8ByteLength = (value: string): number => {
  let bytes = 0
  let index = 0
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0
    bytes += utf8Width(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes
}

const templateError = (reason: PromptTemplateErrorReason, message: string): PromptTemplateError =>
  new PromptTemplateError({ reason, message })

const templateErrorAt = (
  reason: PromptTemplateErrorReason,
  message: string,
  source: string,
  index: number
): PromptTemplateError => {
  const location = sourceLocation(source, index)
  return new PromptTemplateError({
    reason,
    message: `${message} at line ${location.line}, column ${location.column} (byte ${location.byteOffset}).`,
    location
  })
}
