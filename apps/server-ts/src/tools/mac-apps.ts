import { Effect } from "effect"

import type { ServerTool } from "./define.js"
import { makeMacAppsHelper, type MacAppsHelperOptions } from "./mac-apps-helper.js"
import { makeLocalClock, makeTimeWords } from "./mac-apps-records.js"
import { makeMacCalendarTools } from "./mac-calendar.js"
import { makeMacContactsTools } from "./mac-contacts.js"
import { makeMacRemindersTools } from "./mac-reminders.js"

/**
 * Calendar, Reminders and Contacts on the owner's Mac, through the desktop
 * app's helper. They are registered everywhere, like the computer tools, and
 * refuse with what to do where the helper is not there.
 */
export const makeMacAppsTools = (
  options: MacAppsHelperOptions & {
    /** This Mac's offset from UTC at an instant, in minutes. */
    readonly offsetMinutes?: (at: Date) => number
  } = {}
): ReadonlyArray<ServerTool> => {
  const apps = {
    helper: makeMacAppsHelper(options),
    words: makeTimeWords(options.offsetMinutes),
    clock: makeLocalClock(options.offsetMinutes)
  }
  return [
    ...makeMacCalendarTools(apps),
    ...makeMacRemindersTools(apps),
    ...makeMacContactsTools(apps)
  ]
}

export const macAppsTools = Effect.sync(() => makeMacAppsTools())
