import { Schema } from "effect"
import { expect, it } from "vitest"
import { RunQuestionSchema } from "@arden-hq/protocol/effect/runs"
import {
  StoredRunQuestionSchema,
  storedResolveAnswer,
  wireRunQuestion
} from "../src/persistence/runs/stored-question.js"

const stored = Schema.decodeUnknownSync(StoredRunQuestionSchema)({
  question_id: "q",
  run_id: "r",
  turn_id: "t",
  session_id: "c",
  destination_session_id: "c",
  context: { origin: { kind: "chat", session_id: "c", turn_id: "t" }, task: null },
  content: {
    prompt: "Which?",
    detail: null,
    choices: [
      { id: "a", label: "A", detail: "First" },
      { id: "b", label: "B" }
    ],
    multiple: true
  },
  status: "resolved",
  resolution: {
    client_id: "x",
    answer: { kind: "choices", choice_ids: ["a"], text: "and more" },
    resolved_at: "2026-11-24T00:00:00.000Z"
  },
  continuation: null,
  focus_choice: null,
  permission_offer: { tool_name: null, saved_in: { kind: "everywhere" } },
  source_title: "Planning",
  continuity_revision: 4,
  created_at: "2026-11-24T00:00:00.000Z"
})

it("sends a stored question with every optional part as a tagged state", () => {
  const wire = wireRunQuestion(stored)
  expect(Schema.decodeUnknownSync(RunQuestionSchema)(wire)).toEqual(wire)
  expect(wire).toMatchObject({
    content: {
      detail: { kind: "none" },
      choices: [{ detail: { kind: "given", text: "First" } }, { detail: { kind: "none" } }],
      multiple: true
    },
    resolution: { kind: "resolved", answer: { typed: { kind: "given", text: "and more" } } },
    continuation: { kind: "none" },
    permission_offer: {
      kind: "present",
      tool: { kind: "other" },
      saved: { kind: "saved", place: { kind: "everywhere" } }
    },
    contract_proposal: { kind: "none" },
    source_title: { kind: "present", title: "Planning" },
    continuity: { kind: "present", revision: 4 },
    timer: { kind: "none" }
  })
  expect(
    storedResolveAnswer({ kind: "choices", choice_ids: ["a"], typed: { kind: "none" } })
  ).toEqual({ kind: "choices", choice_ids: ["a"] })
})
