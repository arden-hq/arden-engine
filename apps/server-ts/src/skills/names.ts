export const SKILL_FILE_NAME = { skill: "SKILL.md", disabled: ".disabled" } as const

export const GIT_TREE_TYPE = { blob: "blob", tree: "tree" } as const

export const SKILL_TREE_MODE = {
  regular: "100644",
  executable: "100755",
  directory: "040000"
} as const

export const GIT_DIRECTORY = ".git"
