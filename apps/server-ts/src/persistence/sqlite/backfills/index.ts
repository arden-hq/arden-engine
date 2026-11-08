import {
  spaceHistoryBackfill,
  sessionHistoryBackfill,
  automationHistoryBackfill
} from "../context-history-backfills.js"
import { taskHistoryBackfill, proposalHistoryBackfill } from "../work-history-backfill.js"
import { scriptProgressBackfill } from "../script-executions.js"
import { activeContextStagedBackfill } from "../active-context-staged-backfill.js"
import { chatUploadMessagesBackfill } from "../chat-upload-messages.js"
import { messageTurnIdsBackfill } from "../message-turns.js"
import { runOutcomeBackfill } from "../automation-run-outcome.js"
import { sessionForkOriginBackfill } from "../session-fork-origin-backfill.js"
import { automationInstructionBackfill } from "../automation-instruction-backfill.js"
import { pendingDecisionVisibilityBackfill } from "../pending-decision-visibility-backfill.js"
import { orphanAgentSessionsBackfill } from "../orphan-agent-sessions-backfill.js"
import { spaceWordsBackfill } from "../space-words-backfill.js"
import { checkBackfills, type AnyBackfill } from "./backfill.js"

export const backfills: ReadonlyArray<AnyBackfill> = checkBackfills([
  pendingDecisionVisibilityBackfill,
  activeContextStagedBackfill,
  chatUploadMessagesBackfill,
  scriptProgressBackfill,
  messageTurnIdsBackfill,
  runOutcomeBackfill,
  sessionForkOriginBackfill,
  automationInstructionBackfill,
  taskHistoryBackfill,
  proposalHistoryBackfill,
  spaceHistoryBackfill,
  sessionHistoryBackfill,
  automationHistoryBackfill,
  orphanAgentSessionsBackfill,
  spaceWordsBackfill
])
