import { ToolExecutionError } from "@arden-hq/loop"
import { clipLine } from "@arden-hq/std/text"
import { Schema } from "effect"
import { decodeGoogle } from "./google-request.js"

interface StructuralElement {
  readonly paragraph?: {
    readonly elements?: ReadonlyArray<{
      readonly textRun?: { readonly content?: string }
      readonly inlineObjectElement?: { readonly inlineObjectId?: string }
    }>
    readonly positionedObjectIds?: ReadonlyArray<string>
  }
  readonly table?: {
    readonly tableRows?: ReadonlyArray<{
      readonly tableCells?: ReadonlyArray<{ readonly content?: ReadonlyArray<StructuralElement> }>
    }>
  }
  readonly tableOfContents?: { readonly content?: ReadonlyArray<StructuralElement> }
}

const StructuralContentSchema = Schema.optionalKey(
  Schema.Array(Schema.suspend((): Schema.Codec<StructuralElement> => StructuralElementSchema))
)
const StructuralElementSchema: Schema.Codec<StructuralElement> = Schema.Struct({
  paragraph: Schema.optionalKey(
    Schema.Struct({
      elements: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            textRun: Schema.optionalKey(
              Schema.Struct({ content: Schema.optionalKey(Schema.String) })
            ),
            inlineObjectElement: Schema.optionalKey(
              Schema.Struct({ inlineObjectId: Schema.optionalKey(Schema.String) })
            )
          })
        )
      ),
      positionedObjectIds: Schema.optionalKey(Schema.Array(Schema.String))
    })
  ),
  table: Schema.optionalKey(
    Schema.Struct({
      tableRows: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            tableCells: Schema.optionalKey(
              Schema.Array(Schema.Struct({ content: StructuralContentSchema }))
            )
          })
        )
      )
    })
  ),
  tableOfContents: Schema.optionalKey(Schema.Struct({ content: StructuralContentSchema }))
})

/** An image or drawing placed in a document (Docs `EmbeddedObject`). Google
 *  serves an image's bytes at `contentUri`, an address tagged with the
 *  reader's account that lives about 30 minutes. A drawing has none. */
interface EmbeddedObject {
  readonly title?: string
  readonly description?: string
  readonly imageProperties?: { readonly contentUri?: string }
}

const EmbeddedObjectSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  imageProperties: Schema.optionalKey(
    Schema.Struct({ contentUri: Schema.optionalKey(Schema.String) })
  )
})

interface DocumentTabSource {
  readonly tabProperties: {
    readonly tabId: string
    readonly title: string
    readonly index?: number
  }
  readonly documentTab?: {
    readonly body?: { readonly content?: ReadonlyArray<StructuralElement> }
    readonly inlineObjects?: Readonly<
      Record<
        string,
        { readonly inlineObjectProperties?: { readonly embeddedObject?: EmbeddedObject } }
      >
    >
    readonly positionedObjects?: Readonly<
      Record<
        string,
        { readonly positionedObjectProperties?: { readonly embeddedObject?: EmbeddedObject } }
      >
    >
  }
  readonly childTabs?: ReadonlyArray<DocumentTabSource>
}

const DocumentTabSchema: Schema.Codec<DocumentTabSource> = Schema.Struct({
  tabProperties: Schema.Struct({
    tabId: Schema.NonEmptyString,
    title: Schema.NonEmptyString,
    index: Schema.optionalKey(Schema.Int)
  }),
  documentTab: Schema.optionalKey(
    Schema.Struct({
      body: Schema.optionalKey(Schema.Struct({ content: StructuralContentSchema })),
      inlineObjects: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            inlineObjectProperties: Schema.optionalKey(
              Schema.Struct({ embeddedObject: Schema.optionalKey(EmbeddedObjectSchema) })
            )
          })
        )
      ),
      positionedObjects: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            positionedObjectProperties: Schema.optionalKey(
              Schema.Struct({ embeddedObject: Schema.optionalKey(EmbeddedObjectSchema) })
            )
          })
        )
      )
    })
  ),
  childTabs: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<DocumentTabSource> => DocumentTabSchema))
  )
})

export const docsDocument = decodeGoogle(
  Schema.Struct({
    title: Schema.NonEmptyString,
    tabs: Schema.optionalKey(Schema.Array(DocumentTabSchema))
  }),
  { service: "google_drive", label: "document" }
)

interface DocumentTab {
  readonly id: string
  readonly title: string
  readonly index: number
  readonly parentId: string | null
  readonly depth: number
  readonly path: ReadonlyArray<string>
  readonly content: ReadonlyArray<StructuralElement> | undefined
  readonly objects: ReadonlyMap<string, EmbeddedObject>
}

export interface DocumentImage {
  readonly marker: string
  readonly start: number
  readonly contentUri: string | undefined
}

const SLOT_OPEN = "\uE000"
const SLOT_CLOSE = "\uE001"
const SLOTS = /\uE000(\d+)\uE001/gu
const STRAY_SLOT_MARKS = /[\uE000\uE001]/gu

const MAX_MARKER_LABEL = 80

const textOf = (
  elements: ReadonlyArray<StructuralElement> | undefined,
  objects: ReadonlyMap<string, EmbeddedObject>,
  placed: Array<EmbeddedObject>
): string => {
  const place = (id: string | undefined): string => {
    const object = id === undefined ? undefined : objects.get(id)
    if (object === undefined) return ""
    placed.push(object)
    return `${SLOT_OPEN}${placed.length - 1}${SLOT_CLOSE}`
  }
  return (elements ?? [])
    .map((element) => {
      if (element.paragraph !== undefined) {
        const text = (element.paragraph.elements ?? [])
          .map((part) =>
            part.textRun?.content === undefined
              ? place(part.inlineObjectElement?.inlineObjectId)
              : part.textRun.content.replace(STRAY_SLOT_MARKS, "")
          )
          .join("")
        const floating = (element.paragraph.positionedObjectIds ?? [])
          .map(place)
          .filter((slot) => slot !== "")
          .map((slot) => `${slot}\n`)
          .join("")
        return text + floating
      }
      if (element.table !== undefined) {
        return (element.table.tableRows ?? [])
          .map((row) =>
            (row.tableCells ?? []).map((cell) => textOf(cell.content, objects, placed)).join("\t")
          )
          .join("\n")
      }
      return textOf(element.tableOfContents?.content, objects, placed)
    })
    .join("")
}

export const documentText = (
  tabs: ReadonlyArray<DocumentTab>,
  options: { readonly titled: boolean }
): { readonly text: string; readonly images: ReadonlyArray<DocumentImage> } => {
  const placed: Array<EmbeddedObject> = []
  const raw = tabs
    .map((tab) => {
      const body = textOf(tab.content, tab.objects, placed)
      return options.titled
        ? `${"#".repeat(Math.min(6, tab.depth + 1))} ${tab.title.replace(STRAY_SLOT_MARKS, "")}\n\n${body}`
        : body
    })
    .join("\n\n")
  const images: Array<DocumentImage> = []
  let text = ""
  let from = 0
  for (const slot of raw.matchAll(SLOTS)) {
    const object = placed[Number(slot[1])]
    text += raw.slice(from, slot.index)
    from = slot.index + slot[0].length
    if (object === undefined) continue
    const label = clipLine(object.title || object.description || "", MAX_MARKER_LABEL)
    const kind = object.imageProperties === undefined ? "Drawing" : "Image"
    const marker = `[${kind} ${images.length + 1}${label === "" ? "" : `: ${label}`}]`
    images.push({ marker, start: text.length, contentUri: object.imageProperties?.contentUri })
    text += marker
  }
  return { text: text + raw.slice(from), images }
}

const collectTabs = (
  values: ReadonlyArray<DocumentTabSource>,
  parent: {
    readonly id: string | null
    readonly depth: number
    readonly path: ReadonlyArray<string>
  }
): ReadonlyArray<DocumentTab> =>
  values.flatMap((source) => {
    const { tabId: id, title } = source.tabProperties
    const path = [...parent.path, title]
    const current: DocumentTab = {
      id,
      title,
      index: source.tabProperties.index ?? 0,
      parentId: parent.id,
      depth: parent.depth,
      path,
      content: source.documentTab?.body?.content,
      objects: new Map([
        ...Object.entries(source.documentTab?.inlineObjects ?? {}).flatMap(([objectId, object]) => {
          const embedded = object.inlineObjectProperties?.embeddedObject
          return embedded === undefined ? [] : [[objectId, embedded] as const]
        }),
        ...Object.entries(source.documentTab?.positionedObjects ?? {}).flatMap(
          ([objectId, object]) => {
            const embedded = object.positionedObjectProperties?.embeddedObject
            return embedded === undefined ? [] : [[objectId, embedded] as const]
          }
        )
      ])
    }
    return [current, ...collectTabs(source.childTabs ?? [], { id, depth: parent.depth + 1, path })]
  })

export const documentTabs = (document: {
  readonly tabs?: ReadonlyArray<DocumentTabSource>
}): ReadonlyArray<DocumentTab> => {
  const tabs = collectTabs(document.tabs ?? [], { id: null, depth: 0, path: [] })
  if (tabs.length === 0) {
    throw new ToolExecutionError("Google Docs returned no document tabs.", {
      preview: "Invalid Google Docs response",
      retryable: false
    })
  }
  return tabs
}
