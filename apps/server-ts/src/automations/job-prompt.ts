import { SYSTEM_HANDLER } from "../persistence/automations/model.js"
import {
  AUTOMATION_JOB_PROMPT,
  type AutomationJobPrompt
} from "../persistence/automations/job-prompt.js"
import type {
  AutomationJobLease,
  ClaimedAutomationJobLease
} from "../persistence/automations/store.js"
import { renderSpaceJobPrompt } from "../prompts/space-jobs.js"

const renderAutomationJobPrompt = (prompt: AutomationJobPrompt): string => {
  switch (prompt.kind) {
    case AUTOMATION_JOB_PROMPT.text:
      return prompt.triggerContext === undefined
        ? prompt.text
        : `${prompt.text}\n\n${prompt.triggerContext}`
    case AUTOMATION_JOB_PROMPT.spaceJob: {
      const rendered = renderSpaceJobPrompt(prompt.context)
      return prompt.triggerContext === undefined
        ? rendered
        : `${rendered}\n\n${prompt.triggerContext}`
    }
  }
}

export const withScreenedEvents = (
  job: ClaimedAutomationJobLease,
  screened: { readonly triggerContext: string; readonly itemIds: ReadonlyArray<string> }
): ClaimedAutomationJobLease => {
  const payload = {
    ...job.payload,
    prompt: { ...job.payload.prompt, triggerContext: screened.triggerContext }
  }
  return {
    ...job,
    payload:
      payload.handler === SYSTEM_HANDLER.events
        ? { ...payload, itemIds: screened.itemIds }
        : payload
  }
}

export const renderAutomationJob = (job: ClaimedAutomationJobLease): AutomationJobLease => ({
  ...job,
  payload: { ...job.payload, prompt: renderAutomationJobPrompt(job.payload.prompt) }
})
