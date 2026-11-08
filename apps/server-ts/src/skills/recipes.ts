import { clipLine } from "@arden-hq/std/text"
import type { Skill, SkillRecipe } from "@arden-hq/protocol/skills"
import { SkillRecipeSpaceIdSchema, SkillRecipeTitleSchema } from "@arden-hq/protocol/effect/skills"
import { Option, Schema } from "effect"
import { stringify } from "yaml"
import { slugify, uniqueName } from "@arden-hq/std/slug"

const RECIPE_TITLE_KEY = "arden-recipe"
const RECIPE_SPACE_KEY = "arden-space"

const RecipeMarkSchema = Schema.Struct({
  [RECIPE_TITLE_KEY]: SkillRecipeTitleSchema,
  [RECIPE_SPACE_KEY]: Schema.optionalKey(SkillRecipeSpaceIdSchema)
})

export const recipeOf = (metadata: unknown, content: string): SkillRecipe | null => {
  const mark = Schema.decodeUnknownOption(RecipeMarkSchema)(metadata, {
    onExcessProperty: "preserve"
  })
  if (Option.isNone(mark)) return null
  const prompt = skillBody(content)
  if (prompt === "") return null
  return {
    title: mark.value[RECIPE_TITLE_KEY],
    prompt,
    space_id: mark.value[RECIPE_SPACE_KEY] ?? null
  }
}

const skillBody = (content: string): string => {
  const lines = content.split("\n")
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, "") === "---")
  return closing < 0
    ? ""
    : lines
        .slice(closing + 1)
        .join("\n")
        .trim()
}

const recipeMetadata = (recipe: {
  readonly title: string
  readonly space_id: string | null
}): Record<string, string> =>
  recipe.space_id === null
    ? { [RECIPE_TITLE_KEY]: recipe.title }
    : { [RECIPE_TITLE_KEY]: recipe.title, [RECIPE_SPACE_KEY]: recipe.space_id }

export const recipeName = (title: string, taken: ReadonlySet<string>): string => {
  const words = slugify(title, { normalize: "nfkd", lowerFirst: true })
  const base = /^[a-z]/.test(words)
    ? words.slice(0, 40).replace(/-+$/, "")
    : `recipe-${words}`.slice(0, 40).replace(/-+$/, "")
  return uniqueName(base, taken)
}

export const recipeDescription = (prompt: string): string => {
  return clipLine(prompt, 160)
}

interface DefaultRecipe {
  readonly name: string
  readonly description: string
  readonly title: string
  readonly prompt: string
}

const DEFAULT_RECIPES: ReadonlyArray<DefaultRecipe> = [
  {
    name: "plan-a-day",
    description: "Plan a day from the calendar and active Tasks, conflicts first.",
    title: "Plan a day",
    prompt: "Plan {today} from my calendar and active Tasks. Conflicts first."
  },
  {
    name: "find-an-email",
    description: "Find an email from what the user remembers about it.",
    title: "Find an email",
    prompt: "Find the email about {what you remember}."
  },
  {
    name: "read-a-page",
    description: "Open a link and give the short version.",
    title: "Read a page",
    prompt: "Read {link} and give me the short version."
  },
  {
    name: "chart-something",
    description: "Turn numbers or a table into a chart in the chat.",
    title: "Chart something",
    prompt: "Chart {data or where to find it}."
  }
]

const DEFAULT_VERSION = "1.0.0"

export const recipeSource = (input: {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly title: string
  readonly space_id: string | null
  readonly prompt: string
}): string => {
  const frontmatter = stringify(
    {
      name: input.name,
      description: input.description,
      version: input.version,
      metadata: recipeMetadata(input)
    },
    { lineWidth: 0 }
  ).trimEnd()
  return `---\n${frontmatter}\n---\n\n${input.prompt.trim()}\n`
}

export interface DefaultRecipeSkill {
  readonly skill: Skill
  readonly content: string
}

export const DEFAULT_RECIPE_SKILLS: ReadonlyArray<DefaultRecipeSkill> = Object.freeze(
  DEFAULT_RECIPES.map((recipe) => ({
    skill: {
      name: recipe.name,
      description: recipe.description,
      version: DEFAULT_VERSION,
      enabled: true,
      builtin: true,
      recipe: { title: recipe.title, prompt: recipe.prompt, space_id: null }
    },
    content: recipeSource({ ...recipe, version: DEFAULT_VERSION, space_id: null })
  }))
)

const defaultsByName = new Map(DEFAULT_RECIPE_SKILLS.map((entry) => [entry.skill.name, entry]))

export const defaultRecipeByName = (name: string): DefaultRecipeSkill | undefined =>
  defaultsByName.get(name)
