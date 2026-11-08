import type { CliToolSkill } from "@arden-hq/protocol/cli-tools"
import type { Skill } from "@arden-hq/protocol/skills"

export interface CliToolEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly commands: ReadonlyArray<string>
  readonly version: ReadonlyArray<string> | undefined
  readonly signIn: ReadonlyArray<string> | undefined
  readonly login: ReadonlyArray<string> | undefined
  readonly skills: ReadonlyArray<string>
}

export const CLI_TOOLS: ReadonlyArray<CliToolEntry> = [
  {
    id: "gh",
    name: "GitHub CLI",
    description: "Repositories, issues, pull requests and CI runs on GitHub.",
    commands: ["gh"],
    version: ["--version"],
    signIn: ["auth", "status"],
    login: ["auth", "login"],
    skills: ["github"]
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI's coding agent in the terminal.",
    commands: ["codex"],
    version: ["--version"],
    signIn: ["login", "status"],
    login: ["login"],
    skills: []
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic's coding agent in the terminal.",
    commands: ["claude"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: []
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google's coding agent in the terminal.",
    commands: ["gemini"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: []
  },
  {
    id: "opencode",
    name: "opencode",
    description: "An open-source coding agent in the terminal.",
    commands: ["opencode"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: []
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    description: "Cursor's coding agent in the terminal.",
    commands: ["cursor-agent"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: []
  },
  {
    id: "prime",
    name: "Prime Intellect",
    description: "GPU pods, environments and evals on Prime Intellect.",
    commands: ["prime"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["prime"]
  },
  {
    id: "modal",
    name: "Modal",
    description: "Serverless GPU functions, apps and volumes on Modal.",
    commands: ["modal"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["modal"]
  },
  {
    id: "runpodctl",
    name: "RunPod",
    description: "GPU pods, serverless endpoints and files on RunPod.",
    commands: ["runpodctl"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["runpodctl", "runpod"]
  },
  {
    id: "hf",
    name: "Hugging Face",
    description: "Models, datasets and Spaces on the Hugging Face Hub.",
    commands: ["hf", "huggingface-cli"],
    version: ["version"],
    signIn: undefined,
    login: undefined,
    skills: ["hugging-face-cli", "huggingface"]
  },
  {
    id: "vercel",
    name: "Vercel CLI",
    description: "Deployments, domains and environment variables on Vercel.",
    commands: ["vercel"],
    version: undefined,
    signIn: undefined,
    login: undefined,
    skills: ["vercel-cli", "vercel"]
  },
  {
    id: "wrangler",
    name: "Cloudflare Wrangler",
    description: "Workers, Pages and storage on Cloudflare.",
    commands: ["wrangler"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["wrangler", "cloudflare"]
  },
  {
    id: "supabase",
    name: "Supabase CLI",
    description: "Local and hosted Supabase projects, migrations and functions.",
    commands: ["supabase"],
    version: undefined,
    signIn: undefined,
    login: undefined,
    skills: ["supabase"]
  },
  {
    id: "flyctl",
    name: "Fly.io",
    description: "Apps, machines and secrets on Fly.io.",
    commands: ["flyctl", "fly"],
    version: undefined,
    signIn: undefined,
    login: undefined,
    skills: ["flyctl", "fly"]
  },
  {
    id: "docker",
    name: "Docker",
    description: "Containers and images.",
    commands: ["docker"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["docker"]
  },
  {
    id: "kubectl",
    name: "kubectl",
    description: "Kubernetes clusters.",
    commands: ["kubectl"],
    version: ["version", "--client"],
    signIn: undefined,
    login: undefined,
    skills: ["kubectl", "kubernetes"]
  },
  {
    id: "aws",
    name: "AWS CLI",
    description: "Amazon Web Services.",
    commands: ["aws"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["aws"]
  },
  {
    id: "gcloud",
    name: "Google Cloud CLI",
    description: "Google Cloud projects and services.",
    commands: ["gcloud"],
    version: ["--version"],
    signIn: undefined,
    login: undefined,
    skills: ["gcloud", "google-cloud"]
  },
  {
    id: "az",
    name: "Azure CLI",
    description: "Microsoft Azure.",
    commands: ["az"],
    version: undefined,
    signIn: undefined,
    login: undefined,
    skills: ["azure"]
  },
  {
    id: "terraform",
    name: "Terraform",
    description: "Infrastructure as code.",
    commands: ["terraform"],
    version: ["version"],
    signIn: undefined,
    login: undefined,
    skills: ["terraform"]
  }
]

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)?)/

export const parseVersion = (output: string): string | null => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
  for (const line of lines) {
    const match = VERSION.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

export const skillFor = (entry: CliToolEntry, skills: ReadonlyArray<Skill>): CliToolSkill => {
  for (const name of entry.skills) {
    const skill = skills.find((candidate) => candidate.name === name && candidate.recipe === null)
    if (skill === undefined) continue
    return skill.builtin
      ? { kind: "built_in", name: skill.name }
      : { kind: "installed", name: skill.name, enabled: skill.enabled }
  }
  return { kind: "none" }
}
