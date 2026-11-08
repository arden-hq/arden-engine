import { AppSettingsTabIdSchema } from "@arden-hq/protocol/effect/common"
import { Schema } from "effect"

export const SessionRefSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "Exact session_ref returned by session_list."
})

export const ToolDestinationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("home").annotate({ description: "Open Arden Home." })
  }),
  Schema.Struct({
    kind: Schema.Literal("session").annotate({ description: "Open one exact Session." }),
    session_ref: SessionRefSchema
  }),
  Schema.Struct({
    kind: Schema.Literal("settings").annotate({
      description: "Open Settings or one Settings tab."
    }),
    tab: Schema.optionalKey(
      AppSettingsTabIdSchema.annotate({
        description: "Exact Settings tab id. Omit to open general Settings."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("automation").annotate({
      description: "Open the Automations list or one exact Automation."
    }),
    automation_ref: Schema.optionalKey(
      Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
        description: "Exact automation_ref from automation_list. Omit to open the Automations list."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("task").annotate({ description: "Open one exact Task's panel." }),
    item_id: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
      description: "Exact item_id returned by space_board_read."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("memory").annotate({
      description: "Open Memory or one exact active Memory page."
    }),
    path: Schema.optionalKey(
      Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
        description:
          "Exact active .md path from wiki_search or wiki_list_pages. Omit to open Memory."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("space").annotate({ description: "Open one exact Space." }),
    space_id: Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
      description: "Exact space_id from space_list."
    })
  })
]).pipe(
  Schema.toTaggedUnion("kind"),
  Schema.annotateEncoded({
    description: "Arden location to open, selected by kind."
  })
)

export type ToolDestination = typeof ToolDestinationSchema.Type

export const placeResource = (destination: ToolDestination, label: string) => {
  const href = placeHref(destination)
  return {
    kind: "target" as const,
    resourceRef: `place:${href}`,
    domain: placeDomain(destination),
    title: label,
    href
  }
}

const placeHref = (destination: ToolDestination): string => {
  const part = (kind: string, value: string | undefined) =>
    value === undefined ? `arden:${kind}` : `arden:${kind}/${encodeURIComponent(value)}`
  switch (destination.kind) {
    case "home":
      return "arden:home"
    case "session":
      return part("session", destination.session_ref)
    case "settings":
      return part("settings", destination.tab)
    case "automation":
      return part("automation", destination.automation_ref)
    case "task":
      return part("task", destination.item_id)
    case "memory":
      return destination.path === undefined
        ? "arden:memory"
        : `arden:memory/${destination.path.split("/").map(encodeURIComponent).join("/")}`
    case "space":
      return part("space", destination.space_id)
  }
}

const placeDomain = (
  destination: ToolDestination
): "session" | "automation" | "memory" | "space" | "task" | "other" => {
  switch (destination.kind) {
    case "session":
    case "automation":
    case "memory":
    case "space":
      return destination.kind
    case "task":
      return "task"
    case "home":
    case "settings":
      return "other"
  }
}
