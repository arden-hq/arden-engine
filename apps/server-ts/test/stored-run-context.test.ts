import { Schema } from "effect"
import { expect, it } from "vitest"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { wireRunContext } from "../src/persistence/runs/stored-context.js"

it("sends a stored Run context with its task, belonging and chain depth as states", () => {
  const stored = [
    { origin: { kind: "chat", session_id: "c", turn_id: "t" }, task: null },
    {
      origin: { kind: "task", item_id: "i", occurrence_id: "o", chain_depth: 2 },
      task: { item_id: "i", generation: 3 },
      belongs_to: { kind: "automation", automation_id: "a", occurrence_id: "o2" }
    },
    { origin: { kind: "unrecorded" }, task: null }
  ] as const
  const wire = stored.map(wireRunContext)
  expect(Schema.decodeUnknownSync(Schema.Array(RunContextSchema))(wire)).toEqual(wire)
  expect(wire[0]).toEqual({
    origin: { kind: "chat", session_id: "c", turn_id: "t", chain_depth: 0 },
    task: { kind: "none" },
    belongs_to: { kind: "own" }
  })
  expect(wire[1]?.belongs_to).toEqual({
    kind: "carried",
    origin: { kind: "automation", automation_id: "a", occurrence_id: "o2", chain_depth: 0 }
  })
})
