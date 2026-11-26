import { Effect } from "effect"

import type { ServerTool } from "./define.js"
import { makeMacAppsHelper, type MacAppsHelperOptions } from "./mac-apps-helper.js"
import { makeLocalClock, makeTimeWords } from "./mac-apps-records.js"
import { makeMacCalendarTools } from "./mac-calendar.js"
import { makeMacContactsTools } from "./mac-contacts.js"
import { makeMacRemindersTools } from "./mac-reminders.js"

export const makeMacAppsTools = (
  options: MacAppsHelperOptions & {
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
