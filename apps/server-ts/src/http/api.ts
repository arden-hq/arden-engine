import { SourceTitlesApi } from "./source-titles/api.js"
import { ProcessesApi } from "./processes/api.js"
import { ComputerApi } from "./computer/api.js"
import { HttpApi } from "effect/unstable/httpapi"
import { HealthApi } from "./health/api.js"
import { ModelsApi } from "./models/api.js"
import { ConfigApi } from "./config/api.js"
import { ToolsApi } from "./tools/api.js"
import { PermissionsApi } from "./permissions/api.js"
import { McpApi } from "./mcp/api.js"
import { GoogleApi } from "./google/api.js"
import { SkillsApi } from "./skills/api.js"
import { StorageApi } from "./storage/api.js"
import { ContextApi } from "./context/api.js"
import { IntelligenceSettingsApi } from "./intelligence-settings/api.js"
import { LimitSettingsApi } from "./limit-settings/api.js"
import { EmbeddingsApi } from "./embeddings/api.js"
import { LocalModelsApi } from "./local-models/api.js"
import { ModelEndpointsApi } from "./model-endpoints/api.js"
import { ChatApi } from "./chat/api.js"
import { RunsApi } from "./runs/api.js"
import { BrowserProceduresApi } from "./browser-procedures/api.js"
import { ScriptsApi } from "./scripts/api.js"
import { AutomationsApi } from "./automations/api.js"
import { SpacesApi } from "./spaces/api.js"
import { ContinuityApi } from "./continuity/api.js"
import { WorkApi } from "./work/api.js"
import { TaskProposalsApi } from "./task-proposals/api.js"
import { FocusChoicesApi } from "./focus-choices/api.js"
import { AnswerBlocksApi } from "./answer-blocks/api.js"
import { SessionsApi } from "./sessions/api.js"
import { TodosApi } from "./todos/api.js"
import { InboxApi } from "./inbox/api.js"
import { WikiApi } from "./wiki/api.js"
import { TerminalsApi } from "./terminals/api.js"
import { MobileApi } from "./mobile/api.js"
import { RelayApi } from "./relay/api.js"
import { CliToolsApi } from "./cli-tools/api.js"

export class ArdenApi extends HttpApi.make("arden-server")
  .add(ComputerApi)
  .add(HealthApi)
  .add(ModelsApi)
  .add(ConfigApi)
  .add(ToolsApi)
  .add(PermissionsApi)
  .add(McpApi)
  .add(GoogleApi)
  .add(SkillsApi)
  .add(StorageApi)
  .add(ContextApi)
  .add(IntelligenceSettingsApi)
  .add(LimitSettingsApi)
  .add(EmbeddingsApi)
  .add(LocalModelsApi)
  .add(ModelEndpointsApi)
  .add(ChatApi)
  .add(RunsApi)
  .add(ScriptsApi)
  .add(BrowserProceduresApi)
  .add(AutomationsApi)
  .add(SpacesApi)
  .add(ContinuityApi)
  .add(TaskProposalsApi)
  .add(FocusChoicesApi)
  .add(AnswerBlocksApi)
  .add(WorkApi)
  .add(SessionsApi)
  .add(TodosApi)
  .add(InboxApi)
  .add(WikiApi)
  .add(TerminalsApi)
  .add(ProcessesApi)
  .add(SourceTitlesApi)
  .add(MobileApi)
  .add(RelayApi)
  .add(CliToolsApi) {}
