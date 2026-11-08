import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  compilePromptTemplate,
  renderPromptTemplate,
  type PromptTemplate
} from "@arden-hq/prompt-template"
import { sha256Hex } from "@arden-hq/std/hash"

import { MONITOR_VERDICT_RULE } from "./run-verdicts.js"

type PromptBand = "auxiliary" | "background" | "fragment" | "stable" | "turn_context"

export interface AuthoredPrompt<Slot extends string> {
  readonly id: string
  readonly revision: number
  readonly sourcePath: string
  readonly band: PromptBand
  readonly template: PromptTemplate
  readonly sourceSha256: string
  readonly render: (values: Readonly<Record<Slot, string>>) => RenderedPrompt
}

export interface RenderedPrompt {
  readonly text: string
  readonly renderedSha256: string
}

interface DefinePromptOptions<Slot extends string> {
  readonly id: string
  readonly revision: number
  readonly sourcePath: string
  readonly band: PromptBand
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

const definePrompt = <const Slot extends string>(
  options: DefinePromptOptions<Slot>
): AuthoredPrompt<Slot> => {
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
  return Object.freeze({
    id: options.id,
    revision: options.revision,
    sourcePath: options.sourcePath,
    band: options.band,
    template,
    sourceSha256: sha256Hex(template.source),
    render: (values: Readonly<Record<Slot, string>>) => {
      const text = renderPromptTemplate({ template, values })
      return Object.freeze({ text, renderedSha256: sha256Hex(text) })
    }
  })
}

const renderText = <Slot extends string>(
  prompt: AuthoredPrompt<Slot>,
  values: Readonly<Record<Slot, string>>
): string => prompt.render(values).text

const untrustedData = definePrompt({
  id: "guidelines.untrusted-data",
  revision: 4,
  sourcePath: "guidelines/untrusted-data.md",
  band: "fragment",
  slots: []
})

const untrustedDataRule = renderText(untrustedData, {})

const memoryFiling = definePrompt({
  id: "memory.filing",
  revision: 3,
  sourcePath: "memory/filing.md",
  band: "fragment",
  slots: []
})

const memoryFilingRule = renderText(memoryFiling, {})

export const PROMPT_CATALOG = Object.freeze({
  untrustedData,
  memoryFiling,
  chatBase: definePrompt({
    id: "chat.base",
    revision: 27,
    sourcePath: "chat/base.md",
    band: "stable",
    slots: ["assistant_name", "untrusted_data_rule"]
  }),
  automationRun: definePrompt({
    id: "surfaces.automation-run",
    revision: 9,
    sourcePath: "surfaces/automation.md",
    band: "turn_context",
    slots: ["monitor_verdict_rule"]
  }),
  workerRun: definePrompt({
    id: "surfaces.worker-run",
    revision: 4,
    sourcePath: "surfaces/worker.md",
    band: "turn_context",
    slots: []
  }),
  compaction: definePrompt({
    id: "auxiliary.compaction",
    revision: 7,
    sourcePath: "auxiliary/compaction.md",
    band: "auxiliary",
    slots: []
  }),
  itemRouter: definePrompt({
    id: "auxiliary.item-router",
    revision: 2,
    sourcePath: "auxiliary/item-router.md",
    band: "auxiliary",
    slots: []
  }),
  ruleCompiler: definePrompt({
    id: "auxiliary.rule-compiler",
    revision: 1,
    sourcePath: "auxiliary/rule-compiler.md",
    band: "auxiliary",
    slots: ["tools", "connectors", "home"]
  }),
  chatOutcomeRouter: definePrompt({
    id: "auxiliary.chat-outcome-router",
    revision: 1,
    sourcePath: "auxiliary/chat-outcome-router.md",
    band: "auxiliary",
    slots: []
  }),
  runPurpose: definePrompt({
    id: "auxiliary.run-purpose",
    revision: 3,
    sourcePath: "auxiliary/run-purpose.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  sessionNaming: definePrompt({
    id: "auxiliary.session-naming",
    revision: 6,
    sourcePath: "auxiliary/session-naming.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  letterSubject: definePrompt({
    id: "auxiliary.letter-subject",
    revision: 3,
    sourcePath: "auxiliary/letter-subject.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  sessionTriage: definePrompt({
    id: "auxiliary.session-triage",
    revision: 3,
    sourcePath: "auxiliary/session-triage.md",
    band: "auxiliary",
    slots: []
  }),
  automationDescription: definePrompt({
    id: "auxiliary.automation-description",
    revision: 2,
    sourcePath: "auxiliary/automation-description.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  recipeDraft: definePrompt({
    id: "auxiliary.recipe-draft",
    revision: 1,
    sourcePath: "auxiliary/recipe-draft.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  spaceInstructions: definePrompt({
    id: "auxiliary.space-instructions",
    revision: 3,
    sourcePath: "auxiliary/space-instructions.md",
    band: "auxiliary",
    slots: ["untrusted_data_rule"]
  }),
  memoryCapture: definePrompt({
    id: "memory.capture",
    revision: 11,
    sourcePath: "memory/capture.md",
    band: "background",
    slots: ["memory_filing_rule"]
  }),
  spaceOverview: definePrompt({
    id: "memory.space-overview",
    revision: 2,
    sourcePath: "memory/space-overview.md",
    band: "auxiliary",
    slots: []
  }),
  chatSummary: definePrompt({
    id: "memory.chat-summary",
    revision: 3,
    sourcePath: "memory/chat-summary.md",
    band: "background",
    slots: []
  }),
  dailySummary: definePrompt({
    id: "memory.daily-summary",
    revision: 1,
    sourcePath: "memory/daily-summary.md",
    band: "background",
    slots: []
  }),
  wikiMaintenance: definePrompt({
    id: "memory.wiki-maintenance",
    revision: 11,
    sourcePath: "memory/wiki-maintenance.md",
    band: "background",
    slots: ["memory_filing_rule"]
  }),
  taskContinuation: definePrompt({
    id: "chat.task-continuation",
    revision: 1,
    sourcePath: "chat/task-continuation.md",
    band: "turn_context",
    slots: ["task_link"]
  }),
  communication: definePrompt({
    id: "context.communication",
    revision: 2,
    sourcePath: "context/communication.md",
    band: "turn_context",
    slots: ["role_guidance"]
  }),
  conversationCommunication: definePrompt({
    id: "context.conversation-communication",
    revision: 3,
    sourcePath: "context/conversation-communication.md",
    band: "turn_context",
    slots: []
  }),
  executorCommunication: definePrompt({
    id: "context.executor-communication",
    revision: 1,
    sourcePath: "context/executor-communication.md",
    band: "turn_context",
    slots: []
  }),
  agentFamily: definePrompt({
    id: "context.agent-family",
    revision: 2,
    sourcePath: "context/agent-family.md",
    band: "turn_context",
    slots: []
  }),
  researchEvidence: definePrompt({
    id: "context.research-evidence",
    revision: 1,
    sourcePath: "context/research-evidence.md",
    band: "turn_context",
    slots: []
  }),
  chatTask: definePrompt({
    id: "context.chat-task",
    revision: 1,
    sourcePath: "context/chat-task.md",
    band: "turn_context",
    slots: ["task_state"]
  }),
  taskState: definePrompt({
    id: "context.task-state",
    revision: 1,
    sourcePath: "context/task-state.md",
    band: "turn_context",
    slots: ["record"]
  }),
  chatTaskOpen: definePrompt({
    id: "context.chat-task-open",
    revision: 1,
    sourcePath: "context/chat-task-open.md",
    band: "turn_context",
    slots: []
  }),
  taskContract: definePrompt({
    id: "context.task-contract",
    revision: 1,
    sourcePath: "context/task-contract.md",
    band: "turn_context",
    slots: []
  }),
  taskAudit: definePrompt({
    id: "context.task-audit",
    revision: 1,
    sourcePath: "context/task-audit.md",
    band: "turn_context",
    slots: []
  }),
  todoOverride: definePrompt({
    id: "context.todo-override",
    revision: 1,
    sourcePath: "context/todo-override.md",
    band: "turn_context",
    slots: ["todo_state"]
  }),
  globalInstructions: definePrompt({
    id: "context.global-instructions",
    revision: 1,
    sourcePath: "context/global-instructions.md",
    band: "turn_context",
    slots: ["assistant_name"]
  }),
  effectiveAccess: definePrompt({
    id: "context.effective-access",
    revision: 2,
    sourcePath: "context/effective-access.md",
    band: "turn_context",
    slots: ["folders", "permissions", "memory"]
  }),
  spaceAuthority: definePrompt({
    id: "context.space-authority",
    revision: 2,
    sourcePath: "context/space-authority.md",
    band: "turn_context",
    slots: []
  }),
  spaceThreads: definePrompt({
    id: "context.space-threads",
    revision: 4,
    sourcePath: "context/space-threads.md",
    band: "turn_context",
    slots: []
  }),
  cliTools: definePrompt({
    id: "context.cli-tools",
    revision: 1,
    sourcePath: "context/cli-tools.md",
    band: "turn_context",
    slots: ["tools"]
  }),
  spaceNavigation: definePrompt({
    id: "context.space-navigation",
    revision: 6,
    sourcePath: "context/space-navigation.md",
    band: "turn_context",
    slots: []
  }),
  capture: definePrompt({
    id: "context.capture",
    revision: 4,
    sourcePath: "context/capture.md",
    band: "turn_context",
    slots: []
  }),
  onboarding: definePrompt({
    id: "context.onboarding",
    revision: 3,
    sourcePath: "context/onboarding.md",
    band: "turn_context",
    slots: []
  }),
  onboardingKickoff: definePrompt({
    id: "chat.onboarding-kickoff",
    revision: 2,
    sourcePath: "chat/onboarding-kickoff.md",
    band: "turn_context",
    slots: []
  }),
  automationFork: definePrompt({
    id: "context.automation-fork",
    revision: 2,
    sourcePath: "context/automation-fork.md",
    band: "turn_context",
    slots: []
  }),
  automationReportElsewhere: definePrompt({
    id: "context.automation-report-elsewhere",
    revision: 2,
    sourcePath: "context/automation-report-elsewhere.md",
    band: "turn_context",
    slots: ["monitor_verdict_rule"]
  }),
  threadStatus: definePrompt({
    id: "context.thread-status",
    revision: 1,
    sourcePath: "context/thread-status.md",
    band: "turn_context",
    slots: []
  }),
  localInstructions: definePrompt({
    id: "context.local-instructions",
    revision: 2,
    sourcePath: "context/local-instructions.md",
    band: "turn_context",
    slots: ["root"]
  }),
  localInstructionsTruncated: definePrompt({
    id: "context.local-instructions-truncated",
    revision: 1,
    sourcePath: "context/local-instructions-truncated.md",
    band: "fragment",
    slots: []
  })
})

export const PROMPT_TEXT = Object.freeze({
  untrustedDataRule,
  memoryFilingRule,
  automationRun: renderText(PROMPT_CATALOG.automationRun, {
    monitor_verdict_rule: MONITOR_VERDICT_RULE
  }),
  workerRun: renderText(PROMPT_CATALOG.workerRun, {}),
  compaction: renderText(PROMPT_CATALOG.compaction, {}),
  itemRouter: renderText(PROMPT_CATALOG.itemRouter, {}),
  chatOutcomeRouter: renderText(PROMPT_CATALOG.chatOutcomeRouter, {}),
  runPurpose: renderText(PROMPT_CATALOG.runPurpose, {
    untrusted_data_rule: untrustedDataRule
  }),
  sessionNaming: renderText(PROMPT_CATALOG.sessionNaming, {
    untrusted_data_rule: untrustedDataRule
  }),
  letterSubject: renderText(PROMPT_CATALOG.letterSubject, {
    untrusted_data_rule: untrustedDataRule
  }),
  sessionTriage: renderText(PROMPT_CATALOG.sessionTriage, {}),
  automationDescription: renderText(PROMPT_CATALOG.automationDescription, {
    untrusted_data_rule: untrustedDataRule
  }),
  recipeDraft: renderText(PROMPT_CATALOG.recipeDraft, {
    untrusted_data_rule: untrustedDataRule
  }),
  spaceInstructions: renderText(PROMPT_CATALOG.spaceInstructions, {
    untrusted_data_rule: untrustedDataRule
  }),
  memoryCapture: renderText(PROMPT_CATALOG.memoryCapture, { memory_filing_rule: memoryFilingRule }),
  wikiMaintenance: renderText(PROMPT_CATALOG.wikiMaintenance, {
    memory_filing_rule: memoryFilingRule
  }),
  dailySummary: renderText(PROMPT_CATALOG.dailySummary, {}),
  chatSummary: renderText(PROMPT_CATALOG.chatSummary, {}),
  spaceOverview: renderText(PROMPT_CATALOG.spaceOverview, {}),
  conversationCommunication: renderText(PROMPT_CATALOG.conversationCommunication, {}),
  executorCommunication: renderText(PROMPT_CATALOG.executorCommunication, {}),
  agentFamily: renderText(PROMPT_CATALOG.agentFamily, {}),
  researchEvidence: renderText(PROMPT_CATALOG.researchEvidence, {}),
  chatTaskOpen: renderText(PROMPT_CATALOG.chatTaskOpen, {}),
  taskContract: renderText(PROMPT_CATALOG.taskContract, {}),
  taskAudit: renderText(PROMPT_CATALOG.taskAudit, {}),
  spaceAuthority: renderText(PROMPT_CATALOG.spaceAuthority, {}),
  spaceNavigation: renderText(PROMPT_CATALOG.spaceNavigation, {}),
  spaceThreads: renderText(PROMPT_CATALOG.spaceThreads, {}),
  capture: renderText(PROMPT_CATALOG.capture, {}),
  onboarding: renderText(PROMPT_CATALOG.onboarding, {}),
  threadStatus: renderText(PROMPT_CATALOG.threadStatus, {}),
  automationFork: renderText(PROMPT_CATALOG.automationFork, {}),
  automationReportElsewhere: renderText(PROMPT_CATALOG.automationReportElsewhere, {
    monitor_verdict_rule: MONITOR_VERDICT_RULE
  }),
  localInstructionsTruncated: renderText(PROMPT_CATALOG.localInstructionsTruncated, {})
})

export const renderChatBasePrompt = (assistantName: string): RenderedPrompt =>
  PROMPT_CATALOG.chatBase.render({
    assistant_name: JSON.stringify(assistantName),
    untrusted_data_rule: untrustedDataRule
  })
