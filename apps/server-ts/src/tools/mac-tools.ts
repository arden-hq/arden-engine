import { Effect } from "effect"

import { computerTools } from "./computer.js"
import type { ServerTool } from "./define.js"
import { macAppsTools } from "./mac-apps.js"

/** The tools that act on the owner's Mac: computer control, and its Calendar, Reminders and Contacts apps. */
export const macTools = Effect.all([computerTools, macAppsTools]).pipe(
  Effect.map((groups): ReadonlyArray<ServerTool> => groups.flat())
)
