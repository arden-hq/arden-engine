import { contextHistorySchemaSection } from "./sections/context-history.js"
import { authorityHistorySchemaSection } from "./sections/authority-history.js"
import { spaceOverviewHistorySchemaSection } from "./sections/space-overview-history.js"
import { workHistorySchemaSection } from "./sections/work-history.js"
import type { OperationalSchemaSection } from "./section.js"
import { spaceContinuitySchemaSection } from "./sections/space-continuity.js"
import { spaceReviewSchemaSection } from "./sections/space-review.js"
import { automationSchemaSection } from "./sections/automation.js"
import { capabilitiesSchemaSection } from "./sections/capabilities.js"
import { contextSettingsSchemaSection } from "./sections/context-settings.js"
import { contextWorkSchemaSection } from "./sections/context-work.js"
import { contextSessionSchemaSection } from "./sections/context-session.js"
import { contextExecutionSchemaSection } from "./sections/context-execution.js"
import { contextModelSchemaSection } from "./sections/context-model.js"
import { contextJournalSchemaSection } from "./sections/context-journal.js"
import { contextOperationsSchemaSection } from "./sections/context-operations.js"
import { contextSearchSyncSchemaSection } from "./sections/context-search-sync.js"
import { operationsSchemaSection } from "./sections/operations.js"
import { sessionFilesSchemaSection } from "./sections/session-files.js"
import { storageSettingsSchemaSection } from "./sections/storage-settings.js"
import { workSchemaSection } from "./sections/work.js"
import { scriptSchemaSection } from "./sections/scripts.js"
import { communicationSchemaSection } from "./sections/communication.js"
import { taskAuthoritySchemaSection } from "./sections/task-authority.js"
import { relaySchemaSection } from "./sections/relay.js"
import { dataBackfillsSchemaSection } from "./sections/data-backfills.js"
import { connectionItemsSchemaSection } from "./sections/connection-items.js"
import { taskProposalsSchemaSection } from "./sections/task-proposals.js"
import { taskContractSchemaSection } from "./sections/task-contract.js"

import { browserProceduresSchemaSection } from "./sections/browser-procedures.js"
import { driveUploadsSchemaSection } from "./sections/drive-uploads.js"

const sections = [
  driveUploadsSchemaSection,
  browserProceduresSchemaSection,
  contextSettingsSchemaSection,
  contextWorkSchemaSection,
  contextSessionSchemaSection,
  contextExecutionSchemaSection,
  contextModelSchemaSection,
  contextJournalSchemaSection,
  contextOperationsSchemaSection,
  contextSearchSyncSchemaSection,
  automationSchemaSection,
  workSchemaSection,
  operationsSchemaSection,
  storageSettingsSchemaSection,
  sessionFilesSchemaSection,
  scriptSchemaSection,
  capabilitiesSchemaSection,
  spaceReviewSchemaSection,
  spaceContinuitySchemaSection,
  communicationSchemaSection,
  taskAuthoritySchemaSection,
  taskContractSchemaSection,
  relaySchemaSection,
  dataBackfillsSchemaSection,
  connectionItemsSchemaSection,
  taskProposalsSchemaSection,
  workHistorySchemaSection,
  contextHistorySchemaSection,
  authorityHistorySchemaSection,
  spaceOverviewHistorySchemaSection
] as const satisfies ReadonlyArray<OperationalSchemaSection>

export const databaseSchema = {
  sections,
  tables: sections.flatMap((section) => section.tables),
  indexes: sections.flatMap((section) => section.indexes),
  triggers: sections.flatMap((section) => section.triggers),
  statements: sections.flatMap((section) => section.statements)
} as const
