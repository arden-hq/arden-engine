import { Schema, SchemaTransformation } from "effect"

import { SiteSecretNameSchema } from "../browser/service.js"
import {
  atNodeRef,
  OriginSchema,
  originIssues,
  ProfileRefSchema,
  TabRefSchema
} from "./browser-support.js"
import { textSelectFields } from "./text-select.js"

export const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)

export const nodeRefSchema = (description: string) =>
  Schema.String.check(Schema.isPattern(/^@?e[1-9][0-9]*$/u))
    .annotate({ description })
    .pipe(
      Schema.decodeTo(
        Schema.String.check(Schema.isPattern(/^@e[1-9][0-9]*$/u)),
        SchemaTransformation.transform({
          decode: atNodeRef,
          encode: (ref) => ref
        })
      )
    )

const TargetSchema = Schema.Struct({
  node_ref: Schema.optionalKey(
    nodeRefSchema(
      [
        "Element ref (@eN, or eN as the tree prints it) from the latest interactive snapshot of this tab: browser_snapshot or the page the last browser_act returned.",
        "Mutually exclusive with kind/value/name; an approved action execution consumes the snapshot."
      ].join(" ")
    )
  ),
  kind: Schema.optionalKey(
    Schema.Literals([
      "role",
      "text",
      "label",
      "placeholder",
      "alt",
      "title",
      "testid"
    ] as const).annotate({
      description: [
        "Semantic selector kind; requires value and is mutually exclusive with node_ref.",
        "Semantic targets support click, hover, fill, and check only."
      ].join(" ")
    })
  ),
  value: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
      description: "Semantic selector value for kind; required with kind (1-1,000 characters)."
    })
  ),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
      description: "Optional accessible name used only with kind=role to disambiguate a target."
    })
  ),
  exact: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether semantic value/name matching is exact. Defaults to false."
    })
  )
}).check(
  Schema.makeFilter((target) => {
    const issues: Array<Schema.FilterIssue> = []
    const semantic =
      target.kind !== undefined || target.value !== undefined || target.name !== undefined
    if ((target.node_ref !== undefined) === semantic) {
      issues.push({ path: [], issue: "provide either node_ref or a semantic target" })
    }
    if (semantic && (target.kind === undefined || target.value === undefined)) {
      issues.push({ path: [], issue: "semantic targets require kind and value" })
    }
    if (target.kind !== "role" && target.name !== undefined) {
      issues.push({ path: ["name"], issue: "is available only for role targets" })
    }
    return issues
  })
)

const ReadAfterSchema = Schema.Literals(["interactive", "text"] as const).annotate({
  description: [
    "Also read the page once it loads, in this call: interactive (authorizes the next browser_act)",
    "or text. Omit it to read nothing, for example when opening several tabs."
  ].join(" ")
})

export const OpenParametersSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
    description:
      "URL to open or navigate to, or a local HTML file as a file: URL or absolute path (1-4,096 characters)."
  }),
  disposition: Schema.optionalKey(
    Schema.Literals(["current", "new"] as const).annotate({
      description: "Open a new tab or navigate tab_ref in place. Defaults to new."
    })
  ),
  tab_ref: Schema.optionalKey(
    TabRefSchema.annotate({
      description: [
        "Exact tab ref from browser_tabs.",
        "Required for disposition=current and unused for disposition=new."
      ].join(" ")
    })
  ),
  profile_ref: Schema.optionalKey(
    ProfileRefSchema.annotate({
      description: "Profile for a new tab. Defaults to default; ignored for disposition=current."
    })
  ),
  read: Schema.optionalKey(ReadAfterSchema)
}).check(
  Schema.makeFilter((input) =>
    input.disposition === "current" && input.tab_ref === undefined
      ? [{ path: ["tab_ref"], issue: "is required when disposition is current" }]
      : []
  )
)

export const SnapshotParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "Exact tab ref from browser_tabs or browser_open."
  }),
  mode: Schema.optionalKey(
    Schema.Literals(["interactive", "text"] as const).annotate({
      description: [
        "interactive returns actionable @eN refs and authorizes one browser_act; text is read-only page text.",
        "Defaults to interactive."
      ].join(" ")
    })
  ),
  scope: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)).annotate({
      description: "CSS selector that scopes an interactive snapshot. Invalid in text mode."
    })
  ),
  depth: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })).annotate({
      description: "Interactive accessibility-tree depth from 0 to 20. Invalid in text mode."
    })
  ),
  max_chars: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 50_000 })).annotate({
      description:
        "Maximum returned snapshot characters (1,000-50,000). Defaults to 16,000, or 50,000 when grep is set."
    })
  ),
  ...textSelectFields
}).check(
  Schema.makeFilter((input) =>
    (input.mode ?? "interactive") === "text" &&
    (input.scope !== undefined || input.depth !== undefined)
      ? [{ path: [], issue: "scope and depth are available only in interactive mode" }]
      : []
  )
)

export const SnapshotRefSchema = Schema.String.check(
  Schema.isPattern(/^snap-[0-9a-f]{12}$/u)
).annotate({
  description: [
    "The Snapshot ref printed under the interactive snapshot this action is built from:",
    "browser_snapshot, or the page the last action returned. Any other is refused."
  ].join(" ")
})

export const PageAfterSchema = Schema.Union([
  Schema.Literal("none"),
  Schema.Struct({
    scope: SnapshotParametersSchema.fields.scope,
    depth: SnapshotParametersSchema.fields.depth,
    max_chars: SnapshotParametersSchema.fields.max_chars
  })
]).annotate({
  description: [
    "The interactive snapshot returned after the action; it authorizes the next action.",
    "Defaults to how this tab was last read; scope, depth and max_chars work as in browser_snapshot.",
    "none skips it, for a last step or before browser_wait."
  ].join(" ")
})

export const ScreenshotParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "Exact tab ref from browser_tabs or browser_open."
  }),
  annotated: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: [
        "Overlay visual element annotations. Defaults to false.",
        "Annotations are evidence only; call browser_snapshot before browser_act."
      ].join(" ")
    })
  )
})

export const ActParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "Tab of the latest interactive snapshot, which authorizes this one action."
  }),
  profile_ref: ProfileRefSchema.annotate({
    description: "Exact profile_ref for the snapshotted tab; it must still match at execution."
  }),
  origin: OriginSchema.annotate({
    description: [
      "Exact current HTTP(S) origin, such as https://example.com, without a path.",
      "It must still match the tab at execution."
    ].join(" ")
  }),
  action: Schema.Literals([
    "click",
    "dblclick",
    "hover",
    "focus",
    "fill",
    "type",
    "press",
    "select",
    "check",
    "uncheck",
    "scroll"
  ] as const).annotate({
    description: [
      "One action to perform.",
      "press/scroll omit target; fill/type/press require value; select requires values."
    ].join(" ")
  }),
  target: Schema.optionalKey(
    TargetSchema.pipe(
      Schema.annotateEncoded({
        description: [
          "Element target required except for press and scroll.",
          "Use a fresh node_ref unless the action supports a semantic target."
        ].join(" ")
      })
    )
  ),
  value: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(20_000)).annotate({
      description:
        "Text or key required for fill, type, and press (up to 20,000 characters). Never a password: use secret."
    })
  ),
  secret: Schema.optionalKey(
    SiteSecretNameSchema.annotate({
      description: [
        "Name of a secret saved for this site with browser_ask_secret; fill only, in place of value, with a node_ref target.",
        "Arden types it into the password field only while the tab is on the site it was saved for. You never see the value."
      ].join(" ")
    })
  ),
  values: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)))
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({
        description: "Values required only for select; provide 1-100 non-empty strings."
      })
  ),
  direction: Schema.optionalKey(
    Schema.Literals(["up", "down", "left", "right"] as const).annotate({
      description: "Scroll direction, valid only for action=scroll. Defaults to down."
    })
  ),
  amount: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).annotate({
      description: "Scroll distance in pixels (1-10,000), only for action=scroll. Defaults to 500."
    })
  ),
  snapshot_ref: SnapshotRefSchema,
  snapshot: Schema.optionalKey(PageAfterSchema)
}).check(
  Schema.makeFilter((input) => {
    const issues = originIssues(input.origin)

    if (input.action === "press" || input.action === "scroll") {
      if (input.target !== undefined) {
        issues.push({ path: ["target"], issue: `is not used for ${input.action}` })
      }
    } else if (input.target === undefined) {
      issues.push({ path: ["target"], issue: `is required for ${input.action}` })
    }

    const semanticActions = new Set<string>(["click", "hover", "fill", "check"])
    if (
      input.target?.node_ref === undefined &&
      input.target !== undefined &&
      !semanticActions.has(input.action)
    ) {
      issues.push({ path: ["target"], issue: "this action requires a fresh node_ref" })
    }
    if (input.secret !== undefined) {
      if (input.action !== "fill") {
        issues.push({ path: ["secret"], issue: "is available only for fill" })
      }
      if (input.value !== undefined) {
        issues.push({ path: ["value"], issue: "is not used with secret" })
      }
      if (input.target !== undefined && input.target.node_ref === undefined) {
        issues.push({ path: ["target"], issue: "a secret fills a fresh node_ref" })
      }
    } else if (["fill", "type", "press"].includes(input.action) && input.value === undefined) {
      issues.push({ path: ["value"], issue: `is required for ${input.action}` })
    }
    if (input.action === "select" && input.values === undefined) {
      issues.push({ path: ["values"], issue: "is required for select" })
    }
    if (input.action !== "select" && input.values !== undefined) {
      issues.push({ path: ["values"], issue: "is available only for select" })
    }
    if (
      input.action !== "scroll" &&
      (input.direction !== undefined || input.amount !== undefined)
    ) {
      issues.push({ path: [], issue: "direction and amount are available only for scroll" })
    }
    return issues
  })
)

export const WaitParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "Exact tab ref. Waiting invalidates any prior action snapshot."
  }),
  condition: Schema.Literals([
    "load",
    "url",
    "text",
    "element",
    "time",
    "download"
  ] as const).annotate({
    description: [
      "Condition kind: load state, URL pattern, visible text, element selector, elapsed time,",
      "or download: the next file this Session's browser downloaded finishes; returns its saved path in the Downloads folder."
    ].join(" ")
  }),
  value: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description: [
        "Condition value: load-state name, URL pattern, text, selector, or milliseconds for time.",
        "Length 1-4,096. Required for every condition except download, which takes none."
      ].join(" ")
    })
  ),
  timeout_ms: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 })).annotate({
      description: "Maximum wait in milliseconds (100-60,000). Defaults to 30,000."
    })
  ),
  read: Schema.optionalKey(ReadAfterSchema)
}).check(
  Schema.makeFilter((input) => {
    if (input.condition === "download") {
      return input.value === undefined
        ? []
        : [{ path: ["value"], issue: "is not used with condition download" }]
    }
    return input.value === undefined
      ? [{ path: ["value"], issue: "is required for this condition" }]
      : []
  })
)
