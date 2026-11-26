import {
  MARK_COLOUR_CHOICE,
  SPACE_MARK,
  SPACE_MARK_COLOURS,
  SPACE_MARK_MEDIA,
  type SpaceMark,
  type SpaceMarkColour,
  type SpaceMarkMedium
} from "@arden-hq/protocol/spaces"
import { Schema, SchemaTransformation } from "effect"

export interface StoredMarkLook {
  readonly colour: SpaceMarkColour | null
  readonly medium: SpaceMarkMedium
  readonly zoom: number
  readonly aberration: number
  readonly focus: number
}

const unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const StoredMarkLookCurrentSchema = Schema.Struct({
  colour: Schema.NullOr(Schema.Literals(SPACE_MARK_COLOURS)),
  medium: Schema.Literals(SPACE_MARK_MEDIA),
  zoom: unit,
  aberration: unit,
  focus: unit
})

const LEGACY_COLOUR = { white: "white", black: "black" } as const
const LEGACY_MEDIUM = { ink: "ink" } as const

const legacyMarkLook = Schema.Struct({
  colour: Schema.NullOr(
    Schema.Literals([...SPACE_MARK_COLOURS, LEGACY_COLOUR.white, LEGACY_COLOUR.black] as const)
  ),
  medium: Schema.Literals([...SPACE_MARK_MEDIA, LEGACY_MEDIUM.ink] as const),
  zoom: unit,
  aberration: unit,
  focus: unit
}).pipe(
  Schema.decodeTo(
    StoredMarkLookCurrentSchema,
    SchemaTransformation.transform({
      decode: (look) => ({
        ...look,
        colour:
          look.colour === LEGACY_COLOUR.white || look.colour === LEGACY_COLOUR.black
            ? ("mono" as const)
            : look.colour,
        medium: look.medium === LEGACY_MEDIUM.ink ? ("pool" as const) : look.medium
      }),
      encode: (look) => look
    })
  )
)

export const StoredMarkLookSchema: Schema.Codec<StoredMarkLook, unknown> = Schema.Union([
  StoredMarkLookCurrentSchema,
  legacyMarkLook
])

export const publicMark = (stored: StoredMarkLook | null): SpaceMark =>
  stored === null
    ? { kind: SPACE_MARK.automatic }
    : {
        kind: SPACE_MARK.set,
        look: {
          colour:
            stored.colour === null
              ? { kind: MARK_COLOUR_CHOICE.automatic }
              : { kind: MARK_COLOUR_CHOICE.chosen, colour: stored.colour },
          medium: stored.medium,
          zoom: stored.zoom,
          aberration: stored.aberration,
          focus: stored.focus
        }
      }

export const storedMark = (mark: SpaceMark): StoredMarkLook | null => {
  switch (mark.kind) {
    case SPACE_MARK.automatic:
      return null
    case SPACE_MARK.set:
      return {
        colour:
          mark.look.colour.kind === MARK_COLOUR_CHOICE.chosen ? mark.look.colour.colour : null,
        medium: mark.look.medium,
        zoom: mark.look.zoom,
        aberration: mark.look.aberration,
        focus: mark.look.focus
      }
  }
}
