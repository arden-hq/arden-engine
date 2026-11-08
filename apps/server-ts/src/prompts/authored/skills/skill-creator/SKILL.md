---
name: skill-creator
description: Create or revise reusable Arden Skills.
version: 1.0.0
tool_group: Skill creation and updates
---

# Skill creator

- Capture a precise trigger, intended outcome, and non-obvious decisions. Assume the assistant can do ordinary work.
- Keep shared purpose and essential constraints in SKILL.md. Route substantial conditional instructions to linked Markdown files under references/; read them with skill(name, resource) only when relevant.
- A simple self-contained Skill needs no router. Keep useful detail; do not shorten to an arbitrary word count.
- Add scripts for genuinely repeated or deterministic work and assets for generated output. Reading a Skill does not grant permission to execute scripts or change external state.
- Match specificity to risk. Keep real operational invariants and user choices; avoid mirroring tool schemas, fixed recipes, copied manuals, and universal rules from isolated examples.
- Use skill_create for a new package. Its preview includes the proposed instructions and supporting files.
- For an existing local Skill, load its current entrypoint and use skill_update with its hash and complete replacement. An existing Markdown reference can be updated by its resource path and hash. Other supporting files stay unchanged; built-ins are shipped with Arden and cannot be edited this way.
- Validate the important behavior and any new executable helper within the authorized scope. Structural validity alone does not establish quality.
