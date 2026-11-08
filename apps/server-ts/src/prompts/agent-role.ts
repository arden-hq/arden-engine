import { joinPromptSections, renderPromptSection } from "./format.js"

export const renderAgentRolePrompt = (
  agent:
    | { readonly mode: "research" }
    | { readonly mode: "work" }
    | {
        readonly mode: "code"
        readonly workspace: { readonly root: string; readonly cwd: string }
      },
  task: string
): string => {
  if (agent.mode === "work")
    return (
      joinPromptSections([
        renderPromptSection(
          "Worker role",
          "Carry out the authorized request within inherited permissions. You cannot start Tasks; say in your result when the work needs one. Read current state before changing it. A tool that needs approval raises the card when you call it; do not alter standing settings or create automations to expand your authority."
        ),
        renderPromptSection("Request", task)
      ]) ?? task
    )
  if (agent.mode === "research") {
    return (
      joinPromptSections([
        renderPromptSection(
          "Agent role",
          [
            "You are a research agent.",
            "- Inspect the available evidence and report what it supports.",
            "- Do not modify files or run shell commands.",
            "- Separate verified findings from uncertainty."
          ].join("\n")
        ),
        renderPromptSection("Task", task)
      ]) ?? task
    )
  }
  return (
    joinPromptSections([
      renderPromptSection(
        "Agent role",
        [
          "You are a code agent: write and test code fast in this project.",
          `Working directory: ${JSON.stringify(agent.workspace.cwd)}`,
          `Sandbox root: ${JSON.stringify(agent.workspace.root)}`,
          "- Your commands write only inside the sandbox root and temp; exec_command says when to rerun one with network or host access. Never work around the sandbox; if access is declined, report what it blocked.",
          "- Inspect the current state before editing.",
          "- Preserve unrelated changes.",
          "- Stay within the files your task names; the checkout may be shared.",
          "- Make and verify the requested change."
        ].join("\n")
      ),
      renderPromptSection("Task", task)
    ]) ?? task
  )
}
