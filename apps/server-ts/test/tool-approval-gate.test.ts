import { PauseRequested, createToolset, type Interaction as LoopInteraction } from "@arden-hq/loop"
import type { ChatApprovalMode, Interaction as ProtocolInteraction } from "@arden-hq/protocol/chat"
import { describe, expect, it } from "vitest"
import { defineGoogleTool } from "../src/tools/google-tool-grant.js"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { defineServerTool } from "../src/tools/define.js"
import { gatePolicy } from "./kit.js"
import { metadata, pathArgs, run, toolsetFor } from "./tool-approval-gate-kit.js"

type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Declared<T> = T extends object
  ? { [K in keyof T as string extends K ? never : K]: Declared<T[K]> }
  : T
const interactionsAgree: Agrees<Declared<LoopInteraction>, Declared<ProtocolInteraction>> = true

describe("tool approval gate", () => {
  it("agrees with the protocol's Interaction", () => {
    expect(interactionsAgree).toBe(true)
  })

  it("lets Side chats work without a new approval and refuses asks and old card replays", async () => {
    const side = toolsetFor({ mode: "allow", bypass: true, noApproval: true })
    await expect(
      side.toolset.execute({ name: "workspace", args: {}, toolCallId: "free" })
    ).resolves.toMatchObject({ content: "used:default:ask" })
    await expect(
      side.toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "ask"
      })
    ).rejects.toMatchObject({ host: { refusal: { rule: "floor" } } })
    await expect(
      side.toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "replay",
        approval: {
          approved: true,
          feedback: null,
          data: { sandbox_root: "/outside" }
        }
      })
    ).rejects.toMatchObject({ host: { refusal: { rule: "floor" } } })
    expect([side.reviewed, side.deferred, side.offered]).toEqual([[], [], []])
  })

  it("refuses a Side connection pause raised while checking a tool requirement", async () => {
    const side = toolsetFor({
      mode: "ask",
      noApproval: true,
      pausesConnection: true
    })
    await expect(
      side.toolset.execute({
        name: "workspace",
        args: {},
        toolCallId: "connection"
      })
    ).rejects.toMatchObject({ host: { refusal: { rule: "floor" } } })
    expect([side.reviewed, side.deferred, side.offered]).toEqual([[], [], []])
  })

  it("lets a Helper-allowed call run in safe mode with the card's data and records the reason", async () => {
    const { toolset, reviewed } = toolsetFor({
      mode: "safe",
      verdict: async () => ({
        verdict: "allow",
        reason: "The task needs this folder"
      })
    })
    await expect(
      toolset.execute({
        name: "workspace",
        args: { path: "/tmp/project" },
        toolCallId: "1"
      })
    ).resolves.toMatchObject({
      content: "used:/tmp/project:safe:/tmp/project",
      data: {
        approval: {
          by: "helper",
          decision: "approved",
          reason: "The task needs this folder"
        }
      }
    })
    expect(reviewed).toEqual(["workspace"])
  })

  it("reviews a batch's covered steps once and an uncovered call alone", async () => {
    const { toolset, reviewed } = toolsetFor({
      mode: "safe",
      verdict: async () => ({
        verdict: "allow",
        reason: "The plan fits the task"
      })
    })
    const plan = run.reviewPlans.open({
      name: "browser_steps",
      description: "Several actions on one page",
      args: { steps: [] },
      preview: "2 actions"
    })
    plan.cover("step-1")
    plan.cover("step-2")
    const run1 = (toolCallId: string) =>
      toolset.execute({
        name: "workspace",
        args: { path: "/tmp/p" },
        toolCallId
      })
    const ran = [await run1("step-1"), await run1("step-2"), await run1("alone")]
    plan.close()
    expect({
      ran: ran.map((result) => result.content),
      reviews: reviewed.length
    }).toEqual({
      ran: ["used:/tmp/p:safe:/tmp/p", "used:/tmp/p:safe:/tmp/p", "used:/tmp/p:safe:/tmp/p"],
      reviews: 2
    })
  })

  it("pauses on an ask verdict or a failed review with the card's note, and never reviews outside safe mode", async () => {
    const asked = toolsetFor({
      mode: "safe",
      verdict: async () => ({
        verdict: "ask",
        why: { kind: "judged", reason: "Writes outside the project." }
      })
    })
    await expect(
      asked.toolset.execute({
        name: "workspace",
        args: { path: "/x" },
        toolCallId: "2"
      })
    ).rejects.toMatchObject({
      reason: "approval",
      detail: "Use /x?",
      presentation: { title: "Use /x?", why: "Writes outside the project." }
    })
    const failed = toolsetFor({
      mode: "safe",
      verdict: () => Promise.reject(new Error("provider down"))
    })
    const failedPause = failed.toolset.execute({
      name: "workspace",
      args: { path: "/x" },
      toolCallId: "3"
    })
    await expect(failedPause).rejects.toMatchObject({ reason: "approval" })
    await expect(failedPause).rejects.not.toHaveProperty("presentation.why")
    const ask = toolsetFor({
      mode: "ask",
      verdict: async () => ({ verdict: "allow", reason: "unused" })
    })
    const askPause = ask.toolset.execute({
      name: "workspace",
      args: { path: "/x" },
      toolCallId: "4"
    })
    await expect(askPause).rejects.toMatchObject({ reason: "approval" })
    await expect(askPause).rejects.not.toHaveProperty("presentation.why")
    expect([asked.reviewed, failed.reviewed, ask.reviewed]).toEqual([
      ["workspace"],
      ["workspace"],
      []
    ])
  })

  it("never shows a user-only card to the Helper, in Auto or any mode", async () => {
    const auto = toolsetFor({
      mode: "safe",
      userOnly: true,
      verdict: async () => ({ verdict: "allow", reason: "unused" })
    })
    await expect(
      auto.toolset.execute({
        name: "workspace",
        args: { path: "/x" },
        toolCallId: "u1"
      })
    ).rejects.toMatchObject({ reason: "approval" })
    expect(auto.reviewed).toEqual([])
  })

  it("never stalls an unattended run: in every mode its card waits in the run's chat", async () => {
    const allowed = toolsetFor({
      mode: "safe",
      unattended: true,
      verdict: async () => ({ verdict: "allow", reason: "Routine" })
    })
    await expect(
      allowed.toolset.execute({
        name: "workspace",
        args: { path: "/x" },
        toolCallId: "r1"
      })
    ).resolves.toMatchObject({ data: { approval: { by: "helper" } } })
    expect(allowed.deferred).toEqual([])
    for (const options of [
      { mode: "safe", unattended: true },
      { mode: "safe", unattended: true, userOnly: true },
      { mode: "ask", unattended: true }
    ] as const) {
      const kept = toolsetFor(options)
      const outcome = await Promise.resolve(
        kept.toolset.execute({
          name: "workspace",
          args: { path: "/x" },
          toolCallId: "r2"
        })
      ).then(
        () => "ran",
        (cause: unknown) => {
          if (cause instanceof PauseRequested) return "paused"
          const message = String(Reflect.get(cause as object, "message"))
          return /card waits for them in this run's chat/.test(message) ? "waits" : "refused"
        }
      )
      expect({ outcome, deferred: kept.deferred }).toEqual({
        outcome: "waits",
        deferred: ["workspace"]
      })
    }
  })

  it("refuses an unattended call that cannot wait, and keeps no card to replay", async () => {
    for (const options of [
      { mode: "safe", unattended: true, live: true },
      { mode: "ask", unattended: true, live: true },
      { mode: "ask", unattended: true, live: true, decision: "ask" }
    ] as const) {
      const refused = toolsetFor(options)
      const outcome = await Promise.resolve(
        refused.toolset.execute({
          name: "workspace",
          args: { path: "/x" },
          toolCallId: "r3"
        })
      ).then(
        () => "ran",
        (cause: unknown) => (cause instanceof PauseRequested ? "paused" : "failed")
      )
      expect({ outcome, deferred: refused.deferred }).toEqual({
        outcome: "failed",
        deferred: []
      })
    }
  })

  it("lets Auto clear a call-specific requirement only for approval_bypass tools", async () => {
    const bypass = toolsetFor({ mode: "allow", bypass: true })
    await expect(
      bypass.toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "6"
      })
    ).resolves.toMatchObject({
      content: "used:/outside:allow",
      data: { approval: { by: "mode", decision: "approved", mode: "allow" } }
    })
    const plain = toolsetFor({ mode: "allow" })
    await expect(
      plain.toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "7"
      })
    ).rejects.toMatchObject({ reason: "approval" })
  })

  it("offers to stop asking only after a call the person approved", async () => {
    const approved = toolsetFor({ mode: "ask" })
    await approved.toolset.execute({
      name: "workspace",
      args: { path: "/outside" },
      toolCallId: "a",
      approval: {
        approved: true,
        feedback: null,
        data: { sandbox_root: "/outside" }
      }
    })
    expect(approved.offered).toEqual(["workspace"])

    const reviewed = toolsetFor({
      mode: "safe",
      verdict: async () => ({
        verdict: "allow",
        reason: "The task needs this folder"
      })
    })
    await reviewed.toolset.execute({
      name: "workspace",
      args: { path: "/outside" },
      toolCallId: "b"
    })
    const never = toolsetFor({ mode: "allow", bypass: true })
    await never.toolset.execute({
      name: "workspace",
      args: { path: "/outside" },
      toolCallId: "c"
    })
    expect([...reviewed.offered, ...never.offered]).toEqual([])
  })

  it("asks for a call whose Google grant is missing, in every mode, never reviewing it", async () => {
    const reviewed: string[] = []
    const toolFor = (mode: ChatApprovalMode, grantMissing: boolean) =>
      createToolset(
        [
          defineGoogleTool({
            google: {
              accounts: () => [
                {
                  id: "acct-1",
                  email: "me@example.com",
                  authorizations: [
                    {
                      service: "gmail",
                      status: "ready",
                      scopes: grantMissing ? [] : ["https://www.googleapis.com/auth/gmail.modify"]
                    }
                  ]
                }
              ],
              request: () => {
                throw new Error("a grant gate makes no request")
              }
            },
            grant: {
              grant: "gmail_modify",
              what: "change mail",
              note: "Allow mail changes",
              target: () => ({ accountRef: "me@example.com" })
            },
            name: "mailbox",
            description: "Change mail",
            parameters: pathArgs,
            metadata,
            execute: async () => "changed"
          })
        ],
        {
          toJsonSchema: () => ({ type: "object" }),
          approvalGate: makeApprovalGate({
            review: async (input) => {
              reviewed.push(input.name)
              return { verdict: "allow", reason: "unused" }
            },
            policy: gatePolicy(mode)
          })
        }
      )(run)
    for (const mode of ["ask", "safe", "allow"] as const) {
      await expect(
        toolFor(mode, true).execute({
          name: "mailbox",
          args: {},
          toolCallId: `g-${mode}`
        })
      ).rejects.toMatchObject({ reason: "approval" })
    }
    expect(reviewed).toEqual([])
    await expect(
      toolFor("allow", false).execute({
        name: "mailbox",
        args: {},
        toolCallId: "held"
      })
    ).resolves.toMatchObject({ content: "changed" })
  })

  it("records the user's approval and a saved rule, and says nothing for a call that never asks", async () => {
    const { toolset } = toolsetFor({ mode: "ask" })
    await expect(
      toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "8",
        approval: {
          approved: true,
          feedback: null,
          grantStanding: true,
          data: { sandbox_root: "/outside" }
        }
      })
    ).resolves.toMatchObject({
      content: "used:/outside:ask:/outside",
      data: {
        approval: { by: "user", decision: "approved", saved_rule: true }
      }
    })
    const quiet = createToolset(
      [
        defineServerTool({
          name: "quiet",
          description: "Read something",
          parameters: pathArgs,
          metadata: { ...metadata, action: "read", changes_state: false },
          execute: async () => "read"
        })
      ],
      {
        toJsonSchema: () => ({ type: "object" }),
        approvalGate: makeApprovalGate({
          review: async () => ({ verdict: "ask", why: { kind: "failed" } }),
          policy: gatePolicy("allow")
        })
      }
    )(run)
    const result = await quiet.execute({
      name: "quiet",
      args: {},
      toolCallId: "9"
    })
    expect(result.data).toBeNull()
  })
})
