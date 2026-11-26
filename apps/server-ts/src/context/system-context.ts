import { cutText } from "@arden-hq/std/text"
import { CLI_TOOL_VERSION, type CliTool, type CliToolsReport } from "@arden-hq/protocol/cli-tools"
import type { TodoSnapshot } from "@arden-hq/protocol/sessions/todos"

import type { AutomationOriginPolicy } from "../persistence/automations/catalog.js"
import type { SessionRunReference } from "../persistence/runs/queries.js"
import type { AgentChildReference, SessionHistoryHeader } from "../persistence/sessions/model.js"
import { isSpaceWorkJob } from "../persistence/job-classification.js"
import { PROMPTS } from "../prompts/catalog.js"
import { joinPromptSections, renderPromptSection } from "../prompts/format.js"
import { machineTimeZone } from "@arden-hq/std/time"
import type { AutomationId } from "../persistence/automations/model.js"
import type { ChatTaskContext } from "../persistence/work/store.js"
import type { SessionForkOrigin } from "@arden-hq/protocol/sessions"
import { currentMillis } from "../runtime/clock.js"
import { chatHref } from "../sessions/chat-href.js"

const CHAT_TASK_DETAILS_LIMIT = 20_000
const CHAT_TASK_LINE_LIMIT = 2_000

const AUTOMATION_SUFFIX = PROMPTS.automationRun

const WORKER_SUFFIX = PROMPTS.workerRun

const FORK_SUFFIX = renderPromptSection("Working in a copy", PROMPTS.automationFork)
const REPORT_ELSEWHERE_SUFFIX = renderPromptSection(
  "Reporting to the chat",
  PROMPTS.automationReportElsewhere
)

export const renderAgentFamilyContext = (
  lineage: ReadonlyArray<SessionHistoryHeader>,
  directChildren: ReadonlyArray<AgentChildReference>,
  childRuns: ReadonlyMap<string, SessionRunReference>
): string => {
  const current = lineage[0]
  if (!current) throw new Error("Session lineage is empty")
  const parent = lineage[1]
  const link = (session: SessionHistoryHeader) => chatHref({ publicRef: session.publicRef })
  return renderPromptSection(
    "Agent family",
    [
      `Your conversation: [${current.publicRef}](${link(current)}).`,
      `Your agent depth: ${lineage.length - 1} (the root conversation is depth 0).`,
      parent
        ? `Your direct parent: [${parent.publicRef}](${link(parent)}).`
        : "You are the root; you have no agent parent.",
      directChildren.length === 0
        ? "You have no direct child agents."
        : [
            "Your recent direct child agents (up to 32, active first):",
            ...directChildren.map((child) => {
              const runs = childRuns.get(child.sessionId)
              const current =
                runs === undefined
                  ? "current run not retained"
                  : `current run ${runs.current.runId} (${runs.current.status})`
              const ending =
                runs?.latestEnding === undefined
                  ? "no decided ending recorded"
                  : `decided ending ${runs.latestEnding.runId} (${runs.latestEnding.status}${runs.latestEnding.detail === null ? "" : `/${runs.latestEnding.detail}`})`
              const assignment =
                child.parentRunId === null || child.parentToolCallId === null
                  ? "assignment reference not recorded"
                  : `spawn ${child.parentRunId}/${child.parentToolCallId}`
              return `- [${child.name ?? child.publicRef}](${chatHref({ publicRef: child.publicRef })}): purpose ${child.purpose === null ? "not recorded" : JSON.stringify(child.purpose)}; ${assignment}; ${current}; ${ending}.`
            })
          ].join("\n"),
      PROMPTS.agentFamily
    ].join("\n")
  )
}

export const renderForkOriginContext = (
  origin: SessionForkOrigin | undefined
): string | undefined =>
  origin === undefined
    ? undefined
    : renderPromptSection(
        "Fork origin",
        `${origin.sourceSessionRef === null ? `This conversation was forked from chat ${origin.sourceSessionId}; its public reference was not recorded.` : `This conversation was forked from [${origin.sourceSessionRef}](${chatHref({ publicRef: origin.sourceSessionRef })}).`} The captured transcript ends at sequence ${origin.throughSequence}${origin.sourceMessageId === null ? " (the boundary message is unavailable)" : ` (message ${origin.sourceMessageId})`}. This records history only; it does not grant access to the source.`
      )

const jsonText = (value: string, limit: number): string => JSON.stringify(cutText(value, limit))

export const renderLocalTimeContext = ({
  now = () => new Date(currentMillis()),
  timeZone = machineTimeZone
}: {
  readonly now?: () => Date
  readonly timeZone?: () => string
} = {}): string => {
  const zone = timeZone()
  const local = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone
  }).format(now())
  return renderPromptSection("Current local time", `${local} (${zone})`)
}

export const renderExecutionContext = (
  input:
    | {
        readonly automationId: AutomationId
        readonly policy: AutomationOriginPolicy
        readonly placement: "in_place" | "fork" | "own_chat"
      }
    | undefined
): string | undefined => {
  if (input === undefined) return undefined
  if (!isSpaceWorkJob(input.policy) && input.policy.handler === null) {
    switch (input.placement) {
      case "in_place":
        return AUTOMATION_SUFFIX
      case "fork":
        return joinPromptSections([AUTOMATION_SUFFIX, FORK_SUFFIX, REPORT_ELSEWHERE_SUFFIX])
      case "own_chat":
        return joinPromptSections([AUTOMATION_SUFFIX, REPORT_ELSEWHERE_SUFFIX])
    }
  }
  return isSpaceWorkJob(input.policy) ? WORKER_SUFFIX : undefined
}

export const renderResearchAgentContext = (enabled: boolean): string | undefined => {
  if (!enabled) return undefined
  return renderPromptSection("Research evidence protocol", PROMPTS.researchEvidence)
}

export const renderChatTaskContext = (current: ChatTaskContext | undefined): string | undefined => {
  if (current === undefined) return undefined
  const { task } = current
  const working = task.status === "open" && !task.blocked
  const blocked = task.blocked ? `blocked, waiting on ${task.waitingOn ?? "you"}` : task.status
  const state = [
    `Task: ${jsonText(task.text, CHAT_TASK_LINE_LIMIT)}`,
    `Key: ${JSON.stringify(current.key)} (updated_at ${task.updatedAt})`,
    `Status: ${working ? "working" : blocked}`,
    ...(task.body === undefined
      ? []
      : [`Details: ${jsonText(task.body, CHAT_TASK_DETAILS_LIMIT)}`]),
    ...(task.blockReason === undefined
      ? []
      : [`Blocked reason: ${jsonText(task.blockReason, CHAT_TASK_LINE_LIMIT)}`]),
    ...(task.openQuestion === undefined
      ? []
      : [`Open question: ${jsonText(task.openQuestion.prompt, CHAT_TASK_LINE_LIMIT)}`]),
    ...(task.history.length === 0
      ? []
      : [
          "History:",
          ...task.history.map((line) => `- ${jsonText(line.summary, CHAT_TASK_LINE_LIMIT)}`)
        ])
  ].join("\n")
  const body = [
    PROMPTS.chatTask({ task_state: state }),
    ...(working ? [PROMPTS.chatTaskOpen] : [])
  ].join("\n")
  return renderPromptSection("Task in this chat", body)
}

export const renderTodoOverrideContext = (todo: TodoSnapshot | null): string | undefined => {
  if (todo === null) return undefined
  const todoState = [
    ...(todo.items.length === 0
      ? ["- no current items"]
      : todo.items.map((item) => `- [${item.status}] ${jsonText(item.content, 500)}`)),
    ...(todo.explanation === null ? [] : [`Explanation: ${jsonText(todo.explanation, 2_000)}`])
  ].join("\n")
  return renderPromptSection(
    "Todo list (edited by the user)",
    PROMPTS.todoOverride({ todo_state: todoState })
  )
}

export const renderCliToolsContext = (report: CliToolsReport | undefined): string | undefined => {
  if (report === undefined || report.tools.length === 0) return undefined
  const tools = [...report.tools]
    .sort((left, right) => (left.command < right.command ? -1 : 1))
    .map(describeCliTool)
    .join("; ")
  return PROMPTS.cliTools({ tools })
}

const describeCliTool = (tool: CliTool): string => {
  const head = [tool.command, versionWords(tool.version), signInWords(tool.sign_in)]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(" ")
  const skill = usableSkill(tool.skill)
  return skill === undefined ? head : `${head}, Skill ${skill}`
}

const versionWords = (version: CliTool["version"]): string | undefined => {
  switch (version.kind) {
    case CLI_TOOL_VERSION.reported:
      return version.text
    case CLI_TOOL_VERSION.unreported:
      return undefined
  }
}

const signInWords = (signIn: CliTool["sign_in"]): string | undefined => {
  switch (signIn) {
    case "signed_in":
      return "signed in"
    case "signed_out":
      return "not signed in"
    case "unknown":
      return undefined
  }
}

const usableSkill = (skill: CliTool["skill"]): string | undefined => {
  switch (skill.kind) {
    case "built_in":
      return skill.name
    case "installed":
      return skill.enabled ? skill.name : undefined
    case "none":
      return undefined
  }
}
