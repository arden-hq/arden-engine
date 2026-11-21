import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { compilePromptTemplate, renderPromptTemplate } from "@arden-hq/prompt-template"

import { MONITOR_VERDICT_RULE } from "./run-verdicts.js"

interface PromptOptions<Slot extends string> {
  readonly id: string
  readonly sourcePath: string
  readonly slots: readonly Slot[]
}

export const readAuthoredFile = (sourcePath: string): string => {
  const source = readFileSync(new URL(`./authored/${sourcePath}`, import.meta.url), "utf8").replace(
    /\r\n?/g,
    "\n"
  )
  if (!source.endsWith("\n") || source.endsWith("\n\n")) {
    throw new Error(`Authored prompt '${sourcePath}' must end with exactly one newline.`)
  }
  return source
}

export const authoredSkillDirectory = (name: string): string =>
  fileURLToPath(new URL(`./authored/skills/${name}/`, import.meta.url))

const readAuthoredSource = (sourcePath: string): string => {
  const body = readAuthoredFile(sourcePath).slice(0, -1)
  if (body.trim().length === 0)
    throw new Error(`Authored prompt '${sourcePath}' must not be empty.`)
  return body
}

const templatePrompt = <const Slot extends string>(
  options: PromptOptions<Slot>
): ((values: Readonly<Record<Slot, string>>) => string) => {
  const template = compilePromptTemplate({ source: readAuthoredSource(options.sourcePath) })
  const declaredSlots = options.slots
  const slotsMatch =
    template.slots.length === declaredSlots.length &&
    template.slots.every((slot, index) => slot === declaredSlots[index])
  if (!slotsMatch) {
    throw new Error(
      `Authored prompt '${options.id}' slots [${template.slots.join(", ")}] do not match its catalog declaration [${declaredSlots.join(", ")}].`
    )
  }
  return (values) => renderPromptTemplate({ template, values })
}

const fixedPrompt = <const Slot extends string>(
  options: PromptOptions<Slot> & {
    readonly values: Readonly<Record<NoInfer<Slot>, string>>
  }
): string => templatePrompt<Slot>(options)(options.values)

const untrustedDataRule = fixedPrompt({
  id: "guidelines.untrusted-data",
  sourcePath: "guidelines/untrusted-data.md",
  slots: [],
  values: {}
})

const memoryFilingRule = fixedPrompt({
  id: "memory.filing",
  sourcePath: "memory/filing.md",
  slots: [],
  values: {}
})

const renderChatBase = templatePrompt({
  id: "chat.base",
  sourcePath: "chat/base.md",
  slots: ["assistant_name", "untrusted_data_rule"]
})

export const PROMPTS = Object.freeze({
  untrustedDataRule,
  memoryFilingRule,
  chatBase: ({ assistantName }: { readonly assistantName: string }): string =>
    renderChatBase({
      assistant_name: JSON.stringify(assistantName),
      untrusted_data_rule: untrustedDataRule
    }),
  automationRun: fixedPrompt({
    id: "surfaces.automation-run",
    sourcePath: "surfaces/automation.md",
    slots: ["monitor_verdict_rule"],
    values: { monitor_verdict_rule: MONITOR_VERDICT_RULE }
  }),
  workerRun: fixedPrompt({
    id: "surfaces.worker-run",
    sourcePath: "surfaces/worker.md",
    slots: [],
    values: {}
  }),
  compaction: fixedPrompt({
    id: "auxiliary.compaction",
    sourcePath: "auxiliary/compaction.md",
    slots: [],
    values: {}
  }),
  itemRouter: fixedPrompt({
    id: "auxiliary.item-router",
    sourcePath: "auxiliary/item-router.md",
    slots: [],
    values: {}
  }),
  ruleCompiler: templatePrompt({
    id: "auxiliary.rule-compiler",
    sourcePath: "auxiliary/rule-compiler.md",
    slots: ["tools", "connectors", "home"]
  }),
  chatOutcomeRouter: fixedPrompt({
    id: "auxiliary.chat-outcome-router",
    sourcePath: "auxiliary/chat-outcome-router.md",
    slots: [],
    values: {}
  }),
  runPurpose: fixedPrompt({
    id: "auxiliary.run-purpose",
    sourcePath: "auxiliary/run-purpose.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  sessionNaming: fixedPrompt({
    id: "auxiliary.session-naming",
    sourcePath: "auxiliary/session-naming.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  letterSubject: fixedPrompt({
    id: "auxiliary.letter-subject",
    sourcePath: "auxiliary/letter-subject.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  sessionTriage: fixedPrompt({
    id: "auxiliary.session-triage",
    sourcePath: "auxiliary/session-triage.md",
    slots: [],
    values: {}
  }),
  automationDescription: fixedPrompt({
    id: "auxiliary.automation-description",
    sourcePath: "auxiliary/automation-description.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  recipeDraft: fixedPrompt({
    id: "auxiliary.recipe-draft",
    sourcePath: "auxiliary/recipe-draft.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  spaceInstructions: fixedPrompt({
    id: "auxiliary.space-instructions",
    sourcePath: "auxiliary/space-instructions.md",
    slots: ["untrusted_data_rule"],
    values: { untrusted_data_rule: untrustedDataRule }
  }),
  memoryCapture: fixedPrompt({
    id: "memory.capture",
    sourcePath: "memory/capture.md",
    slots: ["memory_filing_rule"],
    values: { memory_filing_rule: memoryFilingRule }
  }),
  chatSummary: fixedPrompt({
    id: "memory.chat-summary",
    sourcePath: "memory/chat-summary.md",
    slots: [],
    values: {}
  }),
  dailySummary: fixedPrompt({
    id: "memory.daily-summary",
    sourcePath: "memory/daily-summary.md",
    slots: [],
    values: {}
  }),
  urgentEvents: fixedPrompt({
    id: "memory.urgent-events",
    sourcePath: "memory/urgent-events.md",
    slots: [],
    values: {}
  }),
  wikiMaintenance: fixedPrompt({
    id: "memory.wiki-maintenance",
    sourcePath: "memory/wiki-maintenance.md",
    slots: [],
    values: {}
  }),
  taskContinuation: templatePrompt({
    id: "chat.task-continuation",
    sourcePath: "chat/task-continuation.md",
    slots: ["task_link"]
  }),
  communication: templatePrompt({
    id: "context.communication",
    sourcePath: "context/communication.md",
    slots: ["role_guidance"]
  }),
  conversationCommunication: fixedPrompt({
    id: "context.conversation-communication",
    sourcePath: "context/conversation-communication.md",
    slots: [],
    values: {}
  }),
  executorCommunication: fixedPrompt({
    id: "context.executor-communication",
    sourcePath: "context/executor-communication.md",
    slots: [],
    values: {}
  }),
  agentFamily: fixedPrompt({
    id: "context.agent-family",
    sourcePath: "context/agent-family.md",
    slots: [],
    values: {}
  }),
  researchEvidence: fixedPrompt({
    id: "context.research-evidence",
    sourcePath: "context/research-evidence.md",
    slots: [],
    values: {}
  }),
  chatTask: templatePrompt({
    id: "context.chat-task",
    sourcePath: "context/chat-task.md",
    slots: ["task_state"]
  }),
  taskState: templatePrompt({
    id: "context.task-state",
    sourcePath: "context/task-state.md",
    slots: ["record"]
  }),
  chatTaskOpen: fixedPrompt({
    id: "context.chat-task-open",
    sourcePath: "context/chat-task-open.md",
    slots: [],
    values: {}
  }),
  taskContract: fixedPrompt({
    id: "context.task-contract",
    sourcePath: "context/task-contract.md",
    slots: [],
    values: {}
  }),
  taskAudit: fixedPrompt({
    id: "context.task-audit",
    sourcePath: "context/task-audit.md",
    slots: [],
    values: {}
  }),
  todoOverride: templatePrompt({
    id: "context.todo-override",
    sourcePath: "context/todo-override.md",
    slots: ["todo_state"]
  }),
  globalInstructions: templatePrompt({
    id: "context.global-instructions",
    sourcePath: "context/global-instructions.md",
    slots: ["assistant_name"]
  }),
  effectiveAccess: templatePrompt({
    id: "context.effective-access",
    sourcePath: "context/effective-access.md",
    slots: ["folders", "permissions", "memory"]
  }),
  spaceAuthority: fixedPrompt({
    id: "context.space-authority",
    sourcePath: "context/space-authority.md",
    slots: [],
    values: {}
  }),
  spaceThreads: fixedPrompt({
    id: "context.space-threads",
    sourcePath: "context/space-threads.md",
    slots: [],
    values: {}
  }),
  cliTools: templatePrompt({
    id: "context.cli-tools",
    sourcePath: "context/cli-tools.md",
    slots: ["tools"]
  }),
  spaceNavigation: fixedPrompt({
    id: "context.space-navigation",
    sourcePath: "context/space-navigation.md",
    slots: [],
    values: {}
  }),
  capture: fixedPrompt({
    id: "context.capture",
    sourcePath: "context/capture.md",
    slots: [],
    values: {}
  }),
  onboarding: fixedPrompt({
    id: "context.onboarding",
    sourcePath: "context/onboarding.md",
    slots: [],
    values: {}
  }),
  onboardingKickoff: fixedPrompt({
    id: "chat.onboarding-kickoff",
    sourcePath: "chat/onboarding-kickoff.md",
    slots: [],
    values: {}
  }),
  automationFork: fixedPrompt({
    id: "context.automation-fork",
    sourcePath: "context/automation-fork.md",
    slots: [],
    values: {}
  }),
  automationReportElsewhere: fixedPrompt({
    id: "context.automation-report-elsewhere",
    sourcePath: "context/automation-report-elsewhere.md",
    slots: ["monitor_verdict_rule"],
    values: { monitor_verdict_rule: MONITOR_VERDICT_RULE }
  }),
  threadStatus: fixedPrompt({
    id: "context.thread-status",
    sourcePath: "context/thread-status.md",
    slots: [],
    values: {}
  }),
  localInstructions: templatePrompt({
    id: "context.local-instructions",
    sourcePath: "context/local-instructions.md",
    slots: ["root"]
  }),
  localInstructionsTruncated: fixedPrompt({
    id: "context.local-instructions-truncated",
    sourcePath: "context/local-instructions-truncated.md",
    slots: [],
    values: {}
  })
})
