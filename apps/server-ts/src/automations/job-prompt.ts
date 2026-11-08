import type { AutomationJobPrompt } from "../persistence/automations/job-prompt.js"
import type {
  AutomationJobLease,
  ClaimedAutomationJobLease
} from "../persistence/automations/store.js"
import { renderSpaceJobPrompt } from "../prompts/space-jobs.js"

const renderAutomationJobPrompt = (prompt: AutomationJobPrompt): string => {
  switch (prompt.kind) {
    case "text":
      return prompt.triggerContext === undefined
        ? prompt.text
        : `${prompt.text}\n\n${prompt.triggerContext}`
    case "space_job": {
      const rendered = renderSpaceJobPrompt(prompt.context)
      return prompt.triggerContext === undefined
        ? rendered
        : `${rendered}\n\n${prompt.triggerContext}`
    }
  }
}

export const withTriggerContext = (
  job: ClaimedAutomationJobLease,
  triggerContext: string
): ClaimedAutomationJobLease => ({
  ...job,
  payload: { ...job.payload, prompt: { ...job.payload.prompt, triggerContext } }
})

export const renderAutomationJob = (job: ClaimedAutomationJobLease): AutomationJobLease => ({
  ...job,
  payload: { ...job.payload, prompt: renderAutomationJobPrompt(job.payload.prompt) }
})
