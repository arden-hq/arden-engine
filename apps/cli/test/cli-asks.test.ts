import { describe, expect, it } from "vitest"

import { runCli, type CliClient } from "../src/index.js"
import { HeadlessHttpError, type HeadlessRunEvent } from "@arden-hq/headless"
import type { RunQuestion } from "@arden-hq/protocol/runs"

import { approvalNeeded, catalogEntry, emit, completedRun, defaultClient } from "./kit.js"
import { ASKED_AT, URL_ARGS, testIo } from "./cli-kit.js"

const APP_ONLY = "Only the Arden app can allow this."
const UNCHECKED =
  "Arden could not check whether this can be allowed from here, so it cannot be allowed here. If this keeps happening, update Arden."

const answered = (toolId: string, approved: boolean, standing: boolean, askedAt?: string) => {
  const grant = standing ? { kind: "standing", list: "default" } : { kind: "once" }
  return {
    runId: "run-1",
    toolId,
    result: "",
    decision: approved
      ? { kind: "approved", grant, folder: "keep", edits: { kind: "as_asked" }, as: "as_asked" }
      : { kind: "denied", grant },
    asked: askedAt === undefined ? { kind: "unstated" } : { kind: "at", at: askedAt },
    command: { kind: "none" }
  }
}

const QUESTION: RunQuestion = {
  question_id: "question-1",
  run_id: "run-1",
  turn_id: "turn-1",
  session_id: "session-1",
  destination_session_id: "session-1",
  context: {
    origin: { kind: "chat", session_id: "session-1", turn_id: "turn-1", chain_depth: 0 },
    task: { kind: "none" },
    belongs_to: { kind: "own" }
  },
  content: {
    prompt: "Which inbox?",
    detail: { kind: "none" },
    choices: [
      { id: "work", label: "Work", detail: { kind: "none" } },
      { id: "home", label: "Home", detail: { kind: "none" } }
    ],
    multiple: false
  },
  status: "open",
  resolution: { kind: "unresolved" },
  continuation: { kind: "none" },
  focus_choice: { kind: "none" },
  permission_offer: { kind: "none" },
  contract_proposal: { kind: "none" },
  source_title: { kind: "none" },
  continuity: { kind: "none" },
  created_at: "2026-08-30T00:00:00.000Z",
  timer: { kind: "none" }
}

const QUESTION_EVENT: HeadlessRunEvent = {
  event: "TOOL_CALL_RESULT",
  data: {
    type: "TOOL_CALL_RESULT",
    tool_call_id: "call-ask",
    name: "ask_user",
    run_id: "run-1",
    session_id: "session-1",
    seq: 1,
    timestamp: 1,
    replay: false,
    content: "",
    preview: "",
    display_name: "ask_user",
    kind: "tool",
    is_error: false,
    retry: "unstated",
    duration_ms: 0,
    data: { kind: "attached", value: { question: QUESTION } },
    source_refs: [],
    gmail_send: { kind: "unconfirmed" },
    execution: "runtime"
  }
}

describe("progress and asks at a terminal", () => {
  const askingWith = (answers: Array<string>) => {
    const prompts: Array<string> = []
    return {
      prompts,
      askInTerminal: async (prompt: string) => {
        prompts.push(prompt)
        return answers.shift()
      }
    }
  }

  it("asks for an approval and a connection, and answers with the choice", async () => {
    const approvals: Array<unknown> = []
    const connections: Array<unknown> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, {
          ...approvalNeeded("tool-1"),
          data: {
            ...approvalNeeded("tool-1").data,
            rule_places: [{ kind: "everywhere" }]
          }
        })
        await emit(options, {
          event: "connection_needed",
          data: {
            type: "connection_needed",
            run_id: "run-1",
            tool_id: "tool-2",
            integration_id: "google",
            connection_id: "connection-1",
            label: "Gmail",
            reason: "not_configured",
            detail: "Gmail is not connected.",
            capability: "gmail.read",
            action: "oauth",
            settings_tab: "connections",
            required_scopes: [],
            source: "recovery"
          }
        })
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      },
      answerConnection: async (input) => {
        connections.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["4", "2", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(approvals).toEqual([answered("tool-1", true, true)])
    expect(connections).toEqual([
      {
        runId: "run-1",
        toolId: "tool-2",
        connectionId: "connection-1",
        result: { kind: "default" },
        approved: false
      }
    ])
  })

  it("answers a card with the asking it names, and a card that names none without one", async () => {
    const approvals: Array<unknown> = []
    const card = approvalNeeded("tool-1")
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, {
          ...card,
          data: { ...card.data, asked: { kind: "recorded", at: ASKED_AT } }
        })
        await emit(options, approvalNeeded("tool-2"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(approvals).toEqual([
      answered("tool-1", true, false, ASKED_AT),
      answered("tool-2", false, false)
    ])
  })

  it("offers no grant of a card only the Arden app grants; it can deny it or leave it waiting", async () => {
    const approvals: Array<unknown> = []
    const pay = (toolId: string): HeadlessRunEvent => ({
      event: "approval_needed",
      data: { ...approvalNeeded(toolId).data, name: "vault_pay" }
    })
    const client: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => ({
        tools: [catalogEntry("vault_pay", [{ fact: "card", value: "vault_card_pay" }])],
        unlisted: {}
      }),
      wait: async (_run, options) => {
        await emit(options, pay("pay-1"))
        await emit(options, pay("pay-2"))
        await emit(options, pay("pay-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1", "2"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    const card = `Arden asks to run vault_pay. ${APP_ONLY}\n  1) Deny\n  2) Leave it waiting\nChoose 1-2: `
    expect(asking.prompts).toEqual([card, card])
    expect(approvals).toEqual([answered("pay-1", false, false)])
    expect(io.stderr()).toBe("arden: Deny: vault_pay\narden: vault_pay stays waiting.\n")
  })

  it("a server that will not show its catalog, or a tool it does not list, gets no grant from here", async () => {
    const approvals: Array<unknown> = []
    const listedNowhere: HeadlessRunEvent = {
      event: "approval_needed",
      data: { ...approvalNeeded("tool-2").data, name: "unlisted_tool" }
    }
    const refusing: CliClient = {
      ...defaultClient(),
      toolCatalog: async () => {
        throw new HeadlessHttpError(403, "GET", "/tools", "")
      },
      wait: async (_run, options) => {
        await emit(options, approvalNeeded("tool-1"))
        return completedRun()
      },
      answerApproval: async (input) => {
        approvals.push(input)
      }
    }
    const asking = askingWith(["1"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...testIo({ client: refusing }).dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      `Arden asks to run write_file. ${UNCHECKED}\n  1) Deny\n  2) Leave it waiting\nChoose 1-2: `
    ])
    expect(approvals).toEqual([answered("tool-1", false, false)])

    const missing: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, listedNowhere)
        return completedRun()
      }
    }
    const leaving = askingWith(["2"])
    const io = testIo({ client: missing })
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: leaving.askInTerminal
      })
    ).toBe(0)
    expect(leaving.prompts[0]?.endsWith("1) Deny\n  2) Leave it waiting\nChoose 1-2: ")).toBe(true)
    expect(io.stderr()).toBe("arden: unlisted_tool stays waiting.\n")
  })

  it("answers a question and follows the Run the answer starts", async () => {
    const answered: Array<unknown> = []
    const followed: Array<string> = []
    const client: CliClient = {
      ...defaultClient(),
      wait: async (_run, options) => {
        await emit(options, QUESTION_EVENT)
        return completedRun("Asked")
      },
      answerQuestion: async (questionId, input) => {
        answered.push({ questionId, answer: input.answer })
        return {
          ...QUESTION,
          continuation: { kind: "started", run_id: "run-2", at: "2026-08-30T00:00:02.000Z" }
        }
      },
      waitForRun: async (runId) => {
        followed.push(runId)
        return completedRun("Work inbox: 3 unread")
      }
    }
    const io = testIo({ client })
    const asking = askingWith(["1"])
    expect(
      await runCli(["run", "Prompt", ...URL_ARGS], {
        ...io.dependencies,
        askInTerminal: asking.askInTerminal
      })
    ).toBe(0)
    expect(asking.prompts).toEqual([
      "Arden asks: Which inbox?\n  1) Work\n  2) Home\n  3) Answer later in Arden\nChoose 1-3: "
    ])
    expect(answered).toEqual([
      { questionId: "question-1", answer: { kind: "choice", choice_id: "work" } }
    ])
    expect(followed).toEqual(["run-2"])
    expect(io.stdout()).toBe("Work inbox: 3 unread\n")
  })
})
