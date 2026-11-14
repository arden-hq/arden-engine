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
  expect(renderSpaceContext(view(short)).page).toBe("whole")
  expect(renderSpaceContext(view(long))).toMatchObject({ page: "partial" })
  expect(renderSpaceContext(view(long)).text).toContain("The page continues")
  expect(renderSpaceContext(view({ path: "projects/garden.md", content: "" })).page).toBe("absent")
  expect(renderSpaceContext(view(undefined)).page).toBe("absent")
  // No room left for the page at all.
  expect(renderSpaceContext(view(short), { maxBytes: 200 }).page).toBe("absent")
})
