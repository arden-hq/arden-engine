import { openrouterDecisionTransport } from "./0107_openrouter_decision_transport.js"
import { lastVerdictWins } from "./0108_last_verdict_wins.js"
import { composerShortcut } from "./0109_composer_shortcut.js"
import { activeContextStage } from "./0110_active_context_stage.js"
import { browserReplay } from "./0111_browser_replay.js"
import { removeDeskPause } from "./0112_remove_desk_pause.js"
import { archivedDeskChats } from "./0113_archived_desk_chats.js"
import { decisionLineageWalk } from "./0114_decision_lineage_walk.js"
import { automationRunChatIndex } from "./0115_automation_run_chat_index.js"
import { pendingChatArchive } from "./0116_pending_chat_archive.js"
import { deskConversationFollowsDeskArchive } from "./0117_desk_conversation_follows_desk_archive.js"
import { openAsksBelongTo } from "./0118_open_asks_belong_to.js"
import { taskBelongsToOneChat } from "./0119_task_belongs_to_one_chat.js"
import { browserProcedures } from "./0120_browser_procedures.js"
import { spacePinnedPosition } from "./0121_space_pinned_position.js"
import { spaceMark } from "./0122_space_mark.js"
import { driveUploads } from "./0123_drive_uploads.js"
import { browserProcedureStatuses } from "./0124_browser_procedure_statuses.js"
import { permissionRules } from "./0125_permission_rules.js"
import { connectorOffers } from "./0126_connector_offers.js"
import { siteRules } from "./0127_site_rules.js"
import { spaceSettingsRetired } from "./0128_space_settings_retired.js"
import { ruleOffers } from "./0129_rule_offers.js"
import { pathRules } from "./0130_path_rules.js"
import { ruleWords } from "./0131_rule_words.js"
import { noDefaultFolders } from "./0132_no_default_folders.js"
import { compiledRules } from "./0133_compiled_rules.js"
import { runActivityUsage } from "./0134_run_activity_usage.js"
import { spaceMarkMono } from "./0135_space_mark_mono.js"
import { systemJobOffers } from "./0136_system_job_offers.js"
import { queuedFailure } from "./0137_queued_failure.js"
import { runFailedToError } from "./0138_run_failed_to_error.js"
import { dropTaskArchivedAt } from "./0139_drop_task_archived_at.js"
import { dropRunRecoveryIndex } from "./0140_drop_run_recovery_index.js"
import { spaceNames } from "./0141_space_names.js"
import { journalRetentionCursors } from "./0142_journal_retention_cursors.js"
import { domainMutationLinks } from "./0090_domain_mutation_links.js"
import { effectTargetLabels } from "./0091_effect_target_labels.js"
import { manyCallTargets } from "./0092_many_call_targets.js"
import { contextHistory } from "./0086_context_history.js"
import { authorityHistory } from "./0087_authority_history.js"
import { homeDeskHistoryRefs } from "./0088_home_desk_history_refs.js"
import { deskOverviewHistory } from "./0089_desk_overview_history.js"
import { taskProposalHistory } from "./0085_task_proposal_history.js"
import { forkDisposition } from "./0083_fork_disposition.js"
import { automationInstructionProvenance } from "./0084_automation_instruction_provenance.js"
import { pendingDecisionVisibility } from "./0093_pending_decision_visibility.js"
import { workerAttemptQuietRule } from "./0094_worker_attempt_quiet_rule.js"
import { capabilityOffers } from "./0095_capability_offers.js"
import { permissionChangeOffers } from "./0096_permission_change_offers.js"
import { automationCreatorRoute } from "./0097_automation_creator_route.js"
import { taskStateRecord } from "./0098_task_state_record.js"
import { taskContracts } from "./0099_task_contracts.js"
import { effectTargetPlace } from "./0100_effect_target_place.js"
import { finishedAutomations } from "./0101_finished_automations.js"
import { cardsCloseWithQuestions } from "./0102_cards_close_with_questions.js"
import { shownAsks } from "./0103_shown_asks.js"
import { automationPausedAt } from "./0104_automation_paused_at.js"
import { journaledDecisionRoutes } from "./0105_journaled_decision_routes.js"
import { dropMessageLimit } from "./0106_drop_message_limit.js"
import type { DatabaseSync } from "node:sqlite"
import { questionTimers } from "./0079_question_timers.js"
import { sessionForkOrigin } from "./0080_session_fork_origin.js"
import { backgroundLimitNever } from "./0081_background_limit_never.js"
import { forwardedUserMessages } from "./0082_forwarded_user_messages.js"
import { closedValueChecks } from "./0002_closed_value_checks.js"
import { commandPermissionIdentity } from "./0003_command_permission_identity.js"
import { githubTokenTransport } from "./0004_github_token_transport.js"
import { automationFollowup } from "./0007_automation_followup.js"
import { relayDevices } from "./0008_relay_devices.js"
import { relayPush } from "./0009_relay_push.js"
import { chatHandoffs } from "./0010_chat_handoffs.js"
import { sentChatDoors } from "./0011_sent_chat_doors.js"
import { chatModelEvents } from "./0012_chat_model_events.js"
import { activeRunsIndex } from "./0013_active_runs_index.js"
import { mcpStdioCwd } from "./0014_mcp_stdio_cwd.js"
import { toolCallEffect } from "./0015_tool_call_effect.js"
import { workerAttemptEffects } from "./0016_worker_attempt_effects.js"
import { runAuthority } from "./0017_run_authority.js"
import { dataBackfills } from "./0018_data_backfills.js"
import { inboxReadIndexes } from "./0019_inbox_read_indexes.js"
import { unresolvedToolCallsIndex } from "./0020_unresolved_tool_calls_index.js"
import { activeContext } from "./0021_active_context.js"
import { dropIterationsUsed } from "./0022_drop_iterations_used.js"
import { threadLocation } from "./0023_thread_location.js"
import { goalQuestion } from "./0024_goal_question.js"
import { usageKind } from "./0025_usage_kind.js"
import { modelCallTimes } from "./0026_model_call_times.js"
import { chatUploadCleanup } from "./0027_chat_upload_cleanup.js"
import { connectionItems } from "./0028_connection_items.js"
import { itemRoutingUsage } from "./0029_item_routing_usage.js"
import { homeOffers } from "./0030_home_offers.js"
import { homeOfferOrder } from "./0031_home_offer_order.js"
import { githubSeenSince } from "./0032_github_seen_since.js"
import { connectionItemThreads } from "./0033_connection_item_threads.js"
import { movedThreadLeftovers } from "./0034_moved_thread_leftovers.js"
import { oneTodoTable } from "./0035_one_todo_table.js"
import { dropDiscussions } from "./0036_drop_discussions.js"
import { taskCommentsAreNotes } from "./0037_task_comments_are_notes.js"
import { scriptResultsOutbox } from "./0038_script_results_outbox.js"
import { codeModeScripts } from "./0039_code_mode_scripts.js"
import { deferredToolCalls } from "./0040_deferred_tool_calls.js"
import { tasksWithoutDesk } from "./0041_tasks_without_desk.js"
import { inChatTasks } from "./0042_in_chat_tasks.js"
import { taskToolNames } from "./0043_task_tool_names.js"
import { goalsToTasks } from "./0044_goals_to_tasks.js"
import { deskSuggestSwitch } from "./0045_desk_suggest_switch.js"
import { taskProposeName } from "./0046_task_propose_name.js"
import { openSignalSources } from "./0047_open_signal_sources.js"
import { scriptProgress } from "./0050_script_progress.js"
import { chatPermissionGrants } from "./0051_chat_permission_grants.js"
import { decisionShadowRecords } from "./0054_decision_shadow_records.js"
import { dropDecisionShadowRecords } from "./0055_drop_decision_shadow_records.js"
import { runCompletion } from "./0056_run_completion.js"
import { proposalRetirement } from "./0057_proposal_retirement.js"
import { automationPrefilter } from "./0058_automation_prefilter.js"
import { runOnlyIfPerTrigger } from "./0059_run_only_if_per_trigger.js"
import { deskReviewGate } from "./0060_desk_review_gate.js"
import { messageTurnIds } from "./0061_message_turn_ids.js"
import { automationWriteReceipts } from "./0062_automation_write_receipts.js"
import { triggerIdsAndSkipRecords } from "./0063_trigger_ids_and_skip_records.js"
import { eventFeedCursors } from "./0064_event_feed_cursors.js"
import { approvalReviews } from "./0065_approval_reviews.js"
import { triggerCounterAndCancelledSkips } from "./0066_trigger_counter_and_cancelled_skips.js"
import { runOutcome } from "./0068_run_outcome.js"
import { relayPushNotified } from "./0069_relay_push_notified.js"
import { toolCallEffectTargets } from "./0067_tool_call_effect_targets.js"
import { oneQueueIngress } from "./0070_one_queue_ingress.js"
import { legacyNeedsYouHidden } from "./0072_legacy_needs_you_hidden.js"
import { attemptOutcomeBlocked } from "./0071_attempt_outcome_blocked.js"
import { taskRequestAnchor } from "./0073_task_request_anchor.js"
import { deskChatLinks } from "./0074_desk_chat_links.js"
import { automationPromptAuthor } from "./0075_automation_prompt_author.js"
import { runEndings } from "./0076_run_endings.js"
import { runTells } from "./0077_run_tells.js"
import { managedOutputFence } from "./0078_managed_output_fence.js"
import { oneProposalTable } from "./0048_one_proposal_table.js"
import { taskStopCause } from "./0049_task_stop_cause.js"
import { taskContinuationContext } from "./0005_task_continuation_context.js"
import { taskReportLinks } from "./0006_task_report_links.js"
import { answerBlockState } from "./0052_answer_block_state.js"
import { queuedSentFrom } from "./0053_queued_sent_from.js"

// `enforced` never drops a table: with enforcement on, a DROP runs each child table's ON DELETE.
/**
 * How a migration keeps every reference whole. A whole-database check reads
 * every table that holds a reference, gigabytes on a long-used database, so a
 * migration names the narrowest one that is still sound.
 * - `enforced`: foreign keys stay on while `up` runs, so SQLite refuses a
 *   broken reference at the write that would make it. For a migration that
 *   adds tables, columns or indexes, or rewrites values; never one that drops
 *   a table (with enforcement on, a DROP runs each child table's ON DELETE).
 * - `rebuilds`: `up` drops and recreates `tables`, so it runs with foreign
 *   keys off; the runner then checks those tables and every table that
 *   references them.
 * - `whole`: foreign keys off, then the whole database is checked.
 */
export type MigrationForeignKeys =
  | { readonly kind: "enforced" }
  | { readonly kind: "rebuilds"; readonly tables: ReadonlyArray<string> }
  | { readonly kind: "whole" }

export interface Migration {
  readonly version: number
  readonly name: string
  readonly foreignKeys?: MigrationForeignKeys
  readonly up: (database: DatabaseSync) => void
}

export const BASELINE_VERSION = 1

export const migrations: ReadonlyArray<Migration> = [
  closedValueChecks,
  commandPermissionIdentity,
  githubTokenTransport,
  taskContinuationContext,
  taskReportLinks,
  automationFollowup,
  relayDevices,
  relayPush,
  chatHandoffs,
  sentChatDoors,
  chatModelEvents,
  activeRunsIndex,
  mcpStdioCwd,
  toolCallEffect,
  workerAttemptEffects,
  runAuthority,
  dataBackfills,
  inboxReadIndexes,
  unresolvedToolCallsIndex,
  activeContext,
  dropIterationsUsed,
  threadLocation,
  goalQuestion,
  usageKind,
  modelCallTimes,
  chatUploadCleanup,
  connectionItems,
  itemRoutingUsage,
  homeOffers,
  homeOfferOrder,
  githubSeenSince,
  connectionItemThreads,
  movedThreadLeftovers,
  oneTodoTable,
  dropDiscussions,
  taskCommentsAreNotes,
  scriptResultsOutbox,
  codeModeScripts,
  deferredToolCalls,
  tasksWithoutDesk,
  inChatTasks,
  taskToolNames,
  goalsToTasks,
  deskSuggestSwitch,
  taskProposeName,
  openSignalSources,
  oneProposalTable,
  taskStopCause,
  scriptProgress,
  chatPermissionGrants,
  answerBlockState,
  queuedSentFrom,
  decisionShadowRecords,
  dropDecisionShadowRecords,
  runCompletion,
  proposalRetirement,
  automationPrefilter,
  runOnlyIfPerTrigger,
  deskReviewGate,
  messageTurnIds,
  automationWriteReceipts,
  triggerIdsAndSkipRecords,
  eventFeedCursors,
  approvalReviews,
  triggerCounterAndCancelledSkips,
  toolCallEffectTargets,
  runOutcome,
  relayPushNotified,
  oneQueueIngress,
  attemptOutcomeBlocked,
  legacyNeedsYouHidden,
  taskRequestAnchor,
  deskChatLinks,
  automationPromptAuthor,
  runEndings,
  runTells,
  managedOutputFence,
  questionTimers,
  sessionForkOrigin,
  backgroundLimitNever,
  forwardedUserMessages,
  forkDisposition,
  automationInstructionProvenance,
  taskProposalHistory,
  contextHistory,
  authorityHistory,
  homeDeskHistoryRefs,
  deskOverviewHistory,
  domainMutationLinks,
  effectTargetLabels,
  manyCallTargets,
  pendingDecisionVisibility,
  workerAttemptQuietRule,
  capabilityOffers,
  permissionChangeOffers,
  automationCreatorRoute,
  taskStateRecord,
  taskContracts,
  effectTargetPlace,
  finishedAutomations,
  cardsCloseWithQuestions,
  shownAsks,
  automationPausedAt,
  journaledDecisionRoutes,
  dropMessageLimit,
  openrouterDecisionTransport,
  lastVerdictWins,
  composerShortcut,
  activeContextStage,
  browserReplay,
  removeDeskPause,
  archivedDeskChats,
  decisionLineageWalk,
  automationRunChatIndex,
  pendingChatArchive,
  deskConversationFollowsDeskArchive,
  openAsksBelongTo,
  taskBelongsToOneChat,
  browserProcedures,
  spacePinnedPosition,
  spaceMark,
  driveUploads,
  browserProcedureStatuses,
  permissionRules,
  connectorOffers,
  siteRules,
  spaceSettingsRetired,
  ruleOffers,
  pathRules,
  ruleWords,
  noDefaultFolders,
  compiledRules,
  runActivityUsage,
  spaceMarkMono,
  systemJobOffers,
  queuedFailure,
  runFailedToError,
  dropTaskArchivedAt,
  dropRunRecoveryIndex,
  spaceNames,
  journalRetentionCursors
]

export const checkMigrationOrder = (list: ReadonlyArray<Migration>): number => {
  list.forEach((migration, index) => {
    const expected = BASELINE_VERSION + 1 + index
    if (migration.version !== expected) {
      throw new Error(
        `Migration ${migration.name} has version ${migration.version}; expected ${expected}`
      )
    }
  })
  return list.at(-1)?.version ?? BASELINE_VERSION
}

export const LATEST_SCHEMA_VERSION = checkMigrationOrder(migrations)
