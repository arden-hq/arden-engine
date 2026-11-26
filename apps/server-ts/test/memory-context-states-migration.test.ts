import { Schema } from "effect"
import { expect, it } from "vitest"
import { RunMemoryContextSchema } from "@arden-hq/protocol/effect/runs"
import { todayMemoryComposition } from "../src/persistence/migrations/0201_memory_context_states.js"

const STORED = [
  {
    reader: "owner",
    revision: "rev-1",
    query: "garden?",
    budget: {
      standing_page: 9,
      standing_frame: 1,
      index: 3,
      space: 10,
      space_instructions: 4,
      space_page: 4,
      space_page_list: 2,
      recall: 7
    },
    sources: [
      {
        kind: "space",
        space_id: "s1",
        page_id: null,
        version: null,
        bytes: 5,
        outcome: "whole",
        reason: null
      },
      {
        kind: "space",
        space_id: "s2",
        page_id: "p",
        version: "v",
        bytes: 5,
        outcome: "cut",
        reason: "space_page_allowance"
      },
      { kind: "recalled", page_id: "g", version: "v1", bytes: 3, outcome: "whole", reason: null },
      {
        kind: "recalled",
        role: "record",
        page_id: "r",
        version: "v1",
        bytes: 0,
        outcome: "dropped",
        reason: "recall_allowance"
      }
    ]
  },
  { reader: "worker", revision: null, query: null, sources: [] }
]

it("every stored Memory composition decodes with tagged revision, recall, budget and sources", () => {
  const migrated = STORED.map(todayMemoryComposition)
  const decoded = Schema.decodeUnknownSync(Schema.Array(RunMemoryContextSchema))(migrated)
  expect(decoded[0]).toMatchObject({
    revision: { kind: "read", revision: "rev-1" },
    recall: { kind: "searched", query: "garden?" },
    budget: { kind: "recorded", recall: 7 },
    sources: [
      { kind: "space", page: { kind: "none" }, outcome: "whole" },
      { kind: "space", page: { kind: "page", page_id: "p", version: "v" }, outcome: "cut" },
      { kind: "recalled", role: "unrecorded" },
      { kind: "recalled", role: "record", reason: "recall_allowance" }
    ]
  })
  expect(decoded[0]?.budget).not.toHaveProperty("index")
  expect(decoded[0]?.sources[0]).not.toHaveProperty("reason")
  expect(decoded[1]).toMatchObject({
    revision: { kind: "unread" },
    recall: { kind: "none" },
    budget: { kind: "unrecorded" }
  })
  expect(migrated.map(todayMemoryComposition)).toEqual(migrated)
})
