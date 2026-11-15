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

const shares = { maxBytes: 10_000, instructionsBytes: 4_000, pageBytes: 4_000 }

it("says how much of the Space memory page a chat is sent: whole, in part, or none", () => {
  const short = { path: "projects/garden.md", content: "Seeds ordered." }
  const long = { path: "projects/garden.md", content: "A line about the garden.\n".repeat(400) }
  expect(renderSpaceContext(view(short), shares).page).toBe("whole")
  const partial = renderSpaceContext(view(long), shares)
  expect(partial.page).toBe("cut")
  expect(partial.text).toContain("The page continues")
  expect(renderSpaceContext(view(undefined), shares).page).toBe(undefined)
  // No room left for the page at all.
  expect(renderSpaceContext(view(short), { ...shares, maxBytes: 200 }).page).toBe("dropped")
})
