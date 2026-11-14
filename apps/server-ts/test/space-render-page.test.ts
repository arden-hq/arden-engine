import { expect, it } from "vitest"
import { renderSpaceContext, type SpaceView } from "../src/context/space-render.js"

const view = (page: SpaceView["page"]): SpaceView => ({
  space_id: "space-garden",
  name: "Garden",
  instructions: undefined,
  isConversation: false,
  chats: [],
  page,
  questions: [],
  tasks: []
})

it("says how much of the Space memory page a chat is sent: whole, in part, or none", () => {
  const short = { path: "projects/garden.md", content: "Seeds ordered." }
  const long = { path: "projects/garden.md", content: "A line about the garden.\n".repeat(400) }
  const whole = renderSpaceContext(view(short))
  expect(whole.page).toMatchObject({ path: "projects/garden.md", whole: true })
  const partial = renderSpaceContext(view(long))
  expect(partial.page).toMatchObject({ path: "projects/garden.md", whole: false })
  expect(partial.page?.text).toContain("The page continues")
  // The page's block is exactly as the text holds it.
  for (const { text, page } of [whole, partial]) expect(text).toContain(page?.text)
  expect(renderSpaceContext(view({ path: "projects/garden.md", content: "" })).page).toBe(undefined)
  expect(renderSpaceContext(view(undefined)).page).toBe(undefined)
  // No room left for the page at all.
  expect(renderSpaceContext(view(short), { maxBytes: 200 }).page).toBe(undefined)
})
