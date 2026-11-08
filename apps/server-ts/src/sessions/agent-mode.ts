import type { Schema } from "effect"

export { type AgentMode } from "@arden-hq/protocol/chat"

export interface CodeAgentWorkspace {
  readonly root: string
  readonly cwd: string
}

export type NewAgentSessionMetadata =
  | { readonly mode: "work" }
  | { readonly mode: "research"; readonly researchWorkspaceId: string }
  | { readonly mode: "code"; readonly workspace: CodeAgentWorkspace }

export type AgentSessionMetadata =
  | { readonly mode: "work" }
  | { readonly mode: "research"; readonly researchWorkspaceId: string | null }
  | { readonly mode: "code"; readonly workspace: CodeAgentWorkspace | null }

export const agentSessionMetadata = (
  agent: NewAgentSessionMetadata
): Readonly<Record<string, Schema.Json>> => {
  switch (agent.mode) {
    case "work":
      return { agent: { mode: "work" } }
    case "research":
      return { agent: { mode: "research", research_workspace_id: agent.researchWorkspaceId } }
    case "code":
      return {
        agent: { mode: "code", workspace: { root: agent.workspace.root, cwd: agent.workspace.cwd } }
      }
  }
}

export const readAgentSessionMetadata = (
  metadata: Readonly<Record<string, unknown>>
): AgentSessionMetadata | null => {
  const agent = metadata["agent"]
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return null
  if (!("mode" in agent)) return null
  if (agent.mode === "work") return { mode: "work" }
  if (agent.mode === "research") {
    if ("workspace" in agent) return null
    const researchWorkspaceId =
      "research_workspace_id" in agent ? agent.research_workspace_id : null
    if (researchWorkspaceId !== null && typeof researchWorkspaceId !== "string") return null
    return { mode: "research", researchWorkspaceId }
  }
  if (agent.mode !== "code") return null
  if (!("workspace" in agent)) return { mode: "code", workspace: null }
  const workspace = agent.workspace
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return null
  if (!("root" in workspace) || typeof workspace.root !== "string") return null
  if (!("cwd" in workspace) || typeof workspace.cwd !== "string") return null
  if (workspace.root.length === 0 || workspace.cwd.length === 0) return null
  return {
    mode: "code",
    workspace: { root: workspace.root, cwd: workspace.cwd }
  }
}
