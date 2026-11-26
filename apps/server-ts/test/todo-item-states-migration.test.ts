import { Schema } from "effect"
import { expect, it } from "vitest"
import { TodoListItemSchema } from "@arden-hq/protocol/effect/common"
import { todoItems } from "../src/persistence/migrations/0197_todo_item_states.js"

const STORED = [
  { content: "Read the brief", status: "completed" },
  { id: "kept", content: "Write it", status: "in_progress" },
  { id: "c1", content: "Ask Tim", status: "cancelled", reason: "Not needed" },
  { content: "Old drop", status: "cancelled" }
]

it("every stored todo item decodes with an id and a cancelled item's reason as a state", () => {
  const migrated = todoItems(STORED)
  const decoded = Schema.decodeUnknownSync(Schema.Array(TodoListItemSchema))(migrated)
  expect(decoded.map(({ id: _id, ...item }) => item)).toEqual([
    { content: "Read the brief", status: "completed" },
    { content: "Write it", status: "in_progress" },
    { content: "Ask Tim", status: "cancelled", reason: { kind: "stated", text: "Not needed" } },
    { content: "Old drop", status: "cancelled", reason: { kind: "unstated" } }
  ])
  expect(decoded[1]?.id).toBe("kept")
  expect(todoItems(migrated)).toEqual(migrated)
})
