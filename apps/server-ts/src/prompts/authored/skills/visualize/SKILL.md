---
name: visualize
description: The user's /visualize command. Draw what they asked as an arden:ui block with Chart, Diagram or App; the inline-components Skill has the parts and rules.
version: 4.0.0
tool_group: the /visualize command
user_invocable: true
---

# Visualize

The user asked to see something drawn.

1. Load the inline-components Skill when its instructions are absent from context.
2. Answer with an `arden:ui` block: `Chart` for numbers, `Diagram` for how something works or is built, `App` for a simulation, map, mockup or illustration.
3. Keep the prose around the block short: say what it shows that matters, not how it was made.
