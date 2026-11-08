import { ToolExecutionError } from "@arden-hq/loop"
import {
  SkillNameSchema,
  SkillRecipeSpaceIdSchema,
  SkillVersionSchema
} from "@arden-hq/protocol/effect/skills"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { SkillError } from "../skills/errors.js"
import { SKILL_TOOL_NAME } from "../skills/guard.js"
import { loadSkillInstructions } from "../skills/instructions.js"
import { SkillCatalog } from "../skills/service.js"
import { BUILT_IN_SKILLS } from "../skills/builtin.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolFailure } from "./tool-failure.js"

const SKILLS_HREF = "arden:settings/skills"

const skillRef = (name: string, resource: string | undefined): string =>
  resource === undefined ? `skill:${name}` : `skill:${name}/${resource}`

const ParametersSchema = Schema.Struct({
  name: SkillNameSchema.annotate({
    description:
      "Exact built-in or local Skill name, including a known name omitted from the catalog."
  }),
  resource: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).pipe(
      Schema.annotateEncoded({
        description:
          "Linked Markdown reference under references/. Omit to load SKILL.md. Read only relevant references."
      })
    )
  )
})

const CreateParametersSchema = Schema.Struct({
  name: SkillNameSchema.annotate({
    description: "Lowercase Skill name using letters, digits, and hyphens."
  }),
  description: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).pipe(
    Schema.annotateEncoded({
      description: "Short explanation of what the Skill does and when to use it."
    })
  ),
  version: Schema.optionalKey(
    SkillVersionSchema.annotate({
      description: "Semantic version in major.minor.patch form. Defaults to 1.0.0."
    })
  ),
  body: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500_000)).pipe(
    Schema.annotateEncoded({
      description: [
        "Reusable Markdown instructions after frontmatter. Start with a heading.",
        "Keep shared guidance here and route substantial conditional detail to references."
      ].join(" ")
    })
  ),
  recipe: Schema.optionalKey(
    Schema.Struct({
      title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)).pipe(
        Schema.annotateEncoded({
          description: "Short name the user sees on the Recipe, such as Check a posting."
        })
      ),
      space_id: Schema.NullOr(SkillRecipeSpaceIdSchema).annotate({
        description: "The Space whose new chats offer it first; null offers it everywhere."
      })
    }).annotate({
      description: [
        "Make this a Recipe: a prompt the user sends from the composer, not instructions for you.",
        "body is then the prompt itself, written as the user would say it; mark what they fill in with {short name} blanks.",
        "Recipes never appear in your Skills list."
      ].join(" ")
    })
  ),
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
          description: "Relative path inside scripts, references, or assets."
        }),
        content: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)).annotate({
          description:
            "Complete UTF-8 file content. Add a file only when it materially helps the Skill."
        }),
        executable: Schema.Boolean.annotate({
          description: "Whether this file is executable. May be true only for files under scripts."
        })
      })
    )
      .check(Schema.isMaxLength(128))
      .annotate({
        description: "Optional supporting scripts, focused references, or output assets."
      })
  )
})

const approvalBody = (input: typeof CreateParametersSchema.Type): string => {
  const files = input.files ?? []
  if (files.length === 0) return input.body
  return [
    "SKILL.md body",
    input.body,
    ...files.flatMap((file) => [
      "",
      `${file.path}${file.executable ? " (executable)" : ""}`,
      file.content
    ])
  ].join("\n")
}

const FAILURE_PREVIEWS = {
  not_found: "Skill not found",
  invalid: "Invalid Skill",
  storage: "Skills unavailable",
  unavailable: "Skill marketplace unavailable"
} as const satisfies Record<SkillError["reason"], string>

const NOT_FOUND_MESSAGE = [
  "No Skill has that name.",
  `Built-in Skills: ${BUILT_IN_SKILLS.map((skill) => skill.name).join(", ")}.`,
  "A tool group without one of these needs no Skill; call its tools directly.",
  "For a local Skill, use its exact name from the Skills list, or find it with skill_list."
].join(" ")

const failure = (error: SkillError): ToolExecutionError =>
  toolFailure(
    error.reason === "not_found" ? { reason: error.reason, message: NOT_FOUND_MESSAGE } : error,
    FAILURE_PREVIEWS[error.reason]
  )

const makeSkillTool = ({ skills }: { readonly skills: SkillCatalog["Service"] }): ServerTool =>
  defineServerTool({
    name: SKILL_TOOL_NAME,
    description: [
      "Load one Skill by its exact name from the Skills list: a built-in Skill before the first call to the tool group it names, or a local Skill when its description matches the request. A tool group without a listed Skill needs none.",
      "Call directly, outside code_mode. Read a linked resource only when relevant; reload if instructions were lost through compaction."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      display: { row: "skill" },
      effect: "none",
      code_mode: false,
      display_name: "Load Skill",
      kind: "skill",
      action: "read",
      approval_preview: "Load this local Skill.",
      source: "_skills",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const {
        loaded: content,
        sha256,
        block
      } = await Effect.runPromise(
        loadSkillInstructions({ skills, ...input }).pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      return {
        result: `Loaded /${content.name}${input.resource === undefined ? "" : ` ${input.resource}`}.`,
        preview: content.name,
        data: {
          skill: {
            name: content.name,
            description: content.description,
            version: content.version,
            builtin: content.builtin,
            source_sha256: sha256
          }
        },
        model_content: [block]
      }
    }
  })

const makeSkillCreateTool = ({
  skills
}: {
  readonly skills: SkillCatalog["Service"]
}): ServerTool =>
  defineServerTool({
    name: "skill_create",
    description: [
      "Create one reusable local Skill after the user reviews its full instructions. Built-in Skill names are reserved.",
      "Include only guidance that changes decisions; add supporting files only when useful.",
      "The Skill becomes available immediately as /<name>."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Create Skill",
      standing: "always",
      kind: "skill",
      action: "write",
      approval_preview: "Create this local Skill.",
      source: "_skills",
      changes_state: true,
      concurrency_group: "skills",
      destructive: false,
      default_approval: "ask",
      idempotent: false,
      target: "reported"
    },
    approvalPrompt: async (input) => ({
      presentation: {
        title: "Create this Skill?",
        fields: [
          { label: "Name", value: input.name },
          { label: "Version", value: input.version ?? "1.0.0" },
          { label: "Description", value: input.description },
          ...(input.recipe === undefined ? [] : [{ label: "Recipe", value: input.recipe.title }]),
          { label: "Files", value: String(input.files?.length ?? 0) }
        ],
        body: { label: "Contents", text: approvalBody(input) }
      }
    }),
    execute: async (input, ctx, effects) => {
      const created = await recordApplied(
        effects,
        Effect.runPromise(
          skills
            .create({
              ...input,
              version: input.version ?? "1.0.0",
              files: input.files ?? []
            })
            .pipe(Effect.mapError(failure)),
          { signal: ctx.signal }
        )
      )
      const host = appliedReceipt(ctx, {
        kind: "target",
        resourceRef: skillRef(created.name, undefined),
        domain: "resource",
        title: created.recipe?.title ?? created.name,
        href: SKILLS_HREF
      })
      if (created.recipe !== null) {
        return {
          result: `Saved Recipe ${JSON.stringify(created.recipe.title)}. The user sees it in new chats and in the / menu.`,
          preview: `Saved Recipe ${created.recipe.title}`,
          data: { skill: created },
          host
        }
      }
      return {
        result: `Created /${created.name} v${created.version}. It is available on the next model step.`,
        preview: `Created /${created.name} v${created.version}`,
        data: { skill: created },
        host
      }
    }
  })

const makeSkillListTool = ({ skills }: { readonly skills: SkillCatalog["Service"] }): ServerTool =>
  defineServerTool({
    name: "skill_list",
    description:
      "Discover enabled Skills omitted from context. Page by offset; optionally filter names and descriptions with literal text. Does not load instructions.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        query: Schema.optionalKey(
          Schema.String.check(Schema.isMaxLength(200)).annotate({
            description:
              "Literal case-insensitive text in a name or description. Omit to list all enabled Skills."
          })
        ),
        offset: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
            description: "Zero-based offset; defaults to 0. Reuse next_offset with the same query."
          })
        ),
        limit: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
            description: "Maximum results, 1-20; defaults to 20."
          })
        )
      })
    ),
    metadata: {
      effect: "none",
      display_name: "Find Skills",
      kind: "skill",
      action: "read",
      source: "_skills",
      approval_preview: "Find available Skills.",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const query = (input.query ?? "").toLowerCase()
      const all = await Effect.runPromise(skills.list(), { signal: ctx.signal })
      const matches = all.filter(
        (skill) =>
          skill.enabled && `${skill.name} ${skill.description}`.toLowerCase().includes(query)
      )
      const offset = input.offset ?? 0
      const page = matches.slice(offset, offset + (input.limit ?? 20))
      const next = offset + page.length
      const data = {
        skills: page,
        total: matches.length,
        next_offset: next < matches.length ? next : null
      }
      return { result: JSON.stringify(data), preview: `${page.length} Skills`, data }
    }
  })

const makeSkillUpdateTool = ({
  skills
}: {
  readonly skills: SkillCatalog["Service"]
}): ServerTool =>
  defineServerTool({
    name: "skill_update",
    description:
      "Replace an existing local SKILL.md or linked Markdown reference after reading it with skill. Requires that file's source_sha256 and previews the full replacement. Other files and enabled state stay unchanged; built-ins are immutable.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        name: SkillNameSchema.annotate({
          description: "Exact local Skill name previously read with skill."
        }),
        expected_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
          description:
            "source_sha256 from the current target file load. Stale hashes reject the update."
        }),
        resource: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).pipe(
            Schema.annotateEncoded({
              description: "Existing linked Markdown reference to replace. Omit to update SKILL.md."
            })
          )
        ),
        content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500_000)).annotate({
          description:
            "Complete replacement text. SKILL.md requires valid frontmatter with the same name; references contain Markdown only."
        })
      })
    ),
    metadata: {
      effect: "arden_db",
      display_name: "Update Skill",
      standing: "always",
      kind: "skill",
      action: "write",
      source: "_skills",
      approval_preview: "Update these Skill instructions.",
      changes_state: true,
      concurrency_group: "skills",
      destructive: false,
      default_approval: "ask",
      idempotent: false,
      target: "reported"
    },
    approvalPrompt: async (input) => ({
      presentation: {
        title: "Update this Skill?",
        fields: [{ label: "Name", value: input.name }],
        body: { label: input.resource ?? "Replacement SKILL.md", text: input.content }
      }
    }),
    execute: async (input, ctx, effects) => {
      const updated = await Effect.runPromise(skills.update(input).pipe(Effect.mapError(failure)), {
        signal: ctx.signal
      })
      const source_sha256 = sha256Hex(updated.content)
      const changed = source_sha256 !== input.expected_sha256
      if (changed) effects.applied()
      else effects.unchanged()
      return {
        result: `Updated /${updated.name}. Reload it before following its revised instructions.`,
        preview: `Updated /${updated.name}`,
        data: { name: updated.name, source_sha256 },
        ...(changed
          ? {
              host: appliedReceipt(ctx, {
                kind: "versioned_resource",
                resourceRef: skillRef(updated.name, input.resource),
                beforeVersion: input.expected_sha256,
                afterVersion: source_sha256,
                domain: "resource",
                title:
                  input.resource === undefined ? updated.name : `${updated.name}/${input.resource}`,
                href: SKILLS_HREF
              })
            }
          : {})
      }
    }
  })

export const skillTools = Effect.gen(function* () {
  const skills = yield* SkillCatalog
  return [
    makeSkillTool({ skills }),
    makeSkillListTool({ skills }),
    makeSkillCreateTool({ skills }),
    makeSkillUpdateTool({ skills })
  ]
})
