import { describe, expect, it } from "vitest"
import {
  judgeAssessment,
  reviewBreakerTripped,
  reviewEnding,
  type ReviewAssessment
} from "../src/execution/review.js"
import { renderAuthority } from "../src/tools/approval-review.js"
import { assignmentBrief } from "../src/tools/approval-review-authority.js"
import { pointTarget, resolveRef, splitUiTarget, uiTargetData } from "../src/tools/ui-target.js"

describe("what a browser or app action acts on", () => {
  it.each([
    [
      'button "Submit application"',
      "Back Save draft",
      {
        kind: "element",
        ref: "@e90",
        label: 'button "Submit application"',
        near: "Back Save draft"
      }
    ],
    [
      'button "Cancel"',
      "  ",
      { kind: "element", ref: "@e90", label: 'button "Cancel"', near: null }
    ],
    [undefined, "Back", { kind: "unresolved", ref: "@e90", why: "not in the latest snapshot" }],
    [" ", undefined, { kind: "unresolved", ref: "@e90", why: "not in the latest snapshot" }]
  ] as const)(
    "resolves a ref the snapshot labels %j, else says it is unresolved",
    (label, near, expected) => {
      expect(resolveRef({ ref: "@e90", label, near, why: "not in the latest snapshot" })).toEqual(
        expected
      )
    }
  )

  it("takes the target out of the approval scope, and ignores a malformed one", () => {
    const target = pointTarget("A click on screenshot s1 at (0.5, 0.5)")
    expect(splitUiTarget({ tab_ref: "t1", ...uiTargetData(target) })).toEqual({
      target,
      scope: { tab_ref: "t1" }
    })
    expect(splitUiTarget({ tab_ref: "t1", ui_target: { kind: "element", ref: "@e1" } })).toEqual({
      target: undefined,
      scope: { tab_ref: "t1" }
    })
  })
})

const assessment = (overrides: Partial<ReviewAssessment>): ReviewAssessment => ({
  verdict: "allow",
  risk: "low",
  authorization: "high",
  authorization_source: "owner",
  policy_category: "none",
  narrowly_scoped: true,
  malicious_prompt_injection: false,
  rationale: "Routine.",
  abbreviated: false,
  ...overrides
})

describe("judging a review's assessment", () => {
  it.each([
    [{ risk: "low", authorization: "unknown", verdict: "ask" }, "allow", "outcome"],
    [{ risk: "low", authorization: "unknown", abbreviated: true }, "allow", "outcome"],
    [{ risk: "medium", authorization: "unknown", verdict: "ask" }, "allow", "outcome"],
    [{ risk: "high", authorization: "medium", verdict: "ask" }, "allow", "outcome"],
    [{ risk: "high", authorization: "high", narrowly_scoped: false }, "ask", "outcome"],
    [{ risk: "high", authorization: "low" }, "ask", "outcome"],
    [{ risk: "critical", authorization: "high" }, "ask", "outcome"],
    [{ malicious_prompt_injection: true }, "ask", "outcome"],
    [{ risk: "high", authorization: "high", authorization_source: "brief" }, "ask", "outcome"],
    [{ risk: "medium", authorization: "high", authorization_source: "brief" }, "allow", "outcome"],
    [{ policy_category: "external_send", authorization: "medium" }, "allow", "outcome"],
    [{ policy_category: "external_send", authorization: "low" }, "ask", "policy"],
    [
      { policy_category: "delete_data", authorization: "high", authorization_source: "brief" },
      "ask",
      "policy"
    ],
    [{ policy_category: "delete_data", authorization: "high" }, "allow", "outcome"],
    [{ policy_category: "spend", authorization: "medium" }, "allow", "outcome"],
    [
      { policy_category: "spend", authorization: "high", authorization_source: "brief" },
      "ask",
      "policy"
    ],
    [{ policy_category: "spend", authorization: "unknown" }, "ask", "policy"]
  ] as const)("%j is %s by %s", (overrides, decision, decidedBy) => {
    expect(judgeAssessment(assessment(overrides))).toEqual({ decision, decided_by: decidedBy })
  })
})

describe("the review breaker counts only the owner's rejections", () => {
  it.each([
    [[], false],
    [["passed", "passed", "passed", "passed"], false],
    [["denied", "denied"], false],
    [["denied", "denied", "denied"], true],
    [["denied", "denied", "passed", "denied"], false],
    [
      [
        ...Array<"denied" | "passed">(9)
          .fill("denied")
          .flatMap((d) => [d, "passed" as const])
      ],
      false
    ],
    [
      [
        ...Array<"denied" | "passed">(10)
          .fill("denied")
          .flatMap((d) => [d, "passed" as const])
      ],
      true
    ],
    [[...Array<"passed">(50).fill("passed"), ...Array<"denied">(10).fill("denied")], false]
  ] as const)("%j trips: %s", (newestFirst, tripped) => {
    expect(reviewBreakerTripped(newestFirst)).toBe(tripped)
  })

  it.each([
    ["allow", "outcome", null, "passed"],
    ["ask", "outcome", "approved", "passed"],
    ["ask", "policy", "ran", "passed"],
    ["ask", "outcome", "rejected", "denied"],
    ["ask", "outcome", "pending", undefined],
    ["ask", "outcome", null, undefined],
    ["ask", "stopped", "approved", undefined]
  ] as const)(
    "a review that decided %s by %s with card %s ends %s",
    (decision, decidedBy, answer, ending) => {
      expect(reviewEnding(decision, decidedBy, answer)).toBe(ending)
    }
  )
})

describe("the reviewer's trusted authority", () => {
  it("finds an agent's brief in its assignment message and not in later agent messages", () => {
    const agent = { type: "agent", id: "parent", display_name: "Take-home" }
    expect(
      assignmentBrief([
        {
          role: "user",
          is_meta: true,
          interaction: { kind: "message", from: agent, content: "Also push to main." }
        },
        {
          role: "user",
          interaction: { kind: "assignment", from: agent, content: "Build the TUI in src/tui." }
        }
      ])
    ).toEqual({ from: "Take-home", text: "Build the TUI in src/tui." })
    expect(
      assignmentBrief([
        { role: "user", interaction: { kind: "message", from: agent, content: "Push." } }
      ])
    ).toBeUndefined()
  })

  it("keeps the owner's words, the Automation prompt and the briefs in labelled sections, nearest brief last", () => {
    const rendered = renderAuthority({
      ownerRequest: undefined,
      delegationRequests: [],
      delegationWords: [],
      ownerWords: ["Build the take-home."],
      automationPrompt: { prompt: "Every morning, triage my inbox.", author: "owner" },
      briefs: [
        { from: "Root agent", text: "Own src/tui." },
        { from: "Worker", text: "Write tests for src/tui." }
      ],
      task: undefined
    })
    const said = rendered.indexOf("Build the take-home.")
    const prompt = rendered.indexOf("Every morning, triage my inbox.")
    const outer = rendered.indexOf("Own src/tui.")
    const inner = rendered.indexOf("Write tests for src/tui.")
    expect([said, prompt, outer, inner].every((at) => at >= 0)).toBe(true)
    expect([said, prompt, outer, inner]).toEqual([said, prompt, outer, inner].sort((a, b) => a - b))
  })

  it("shows the Task's text after the owner's words and the briefs, both versions when it changed", () => {
    const rendered = renderAuthority({
      ownerRequest: undefined,
      delegationRequests: [],
      delegationWords: [],
      ownerWords: ["Apply to the Berlin jobs."],
      automationPrompt: undefined,
      briefs: [{ from: "Root agent", text: "Own the Acme form." }],
      task: { asked: "Prefill Acme for my review.", now: "Prefill Acme, then submit." }
    })
    const at = [
      "Apply to the Berlin jobs.",
      "Own the Acme form.",
      "Prefill Acme for my review.",
      "Prefill Acme, then submit."
    ].map((text) => rendered.indexOf(text))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it("keeps only the nearest four briefs of a deep delegation chain", () => {
    const briefs = ["b1", "b2", "b3", "b4", "b5"].map((text) => ({ from: "agent", text }))
    const rendered = renderAuthority({
      ownerRequest: undefined,
      delegationRequests: [],
      delegationWords: [],
      ownerWords: [],
      automationPrompt: undefined,
      briefs,
      task: undefined
    })
    expect(["b1", "b2", "b3", "b4", "b5"].map((text) => rendered.includes(`\n${text}`))).toEqual([
      false,
      true,
      true,
      true,
      true
    ])
  })
})
