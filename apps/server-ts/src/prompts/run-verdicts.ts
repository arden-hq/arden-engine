export const RUN_VERDICTS = {
  blocked:
    "blocked: you cannot finish this Run. Use it instead of inventing a result or reporting success you did not achieve; not when nothing needed doing, and not because one of Arden's own tools refused a call (a refusal changed nothing). Call it by itself after your other results are in: it ends the Run and its line becomes your final reply.",
  news: "news: you found something the user should hear: a new finding, a change, or a result they asked for; give it in one line. A repeating Automation's routine finish shows the user a line only when its Run declared news or changed something; reads, opened pages and its own checklist change nothing.",
  no_change:
    "no_change: you found no meaningful change or actionable finding; give the evidence checked. The Run's routine completion then stays quiet, unless it also changed something (reads, opened pages and its own checklist do not count), a call failed after this report, or it asked a question; a next-check-only update to its scheduled Task is allowed. Never use it for a requested answer, new findings, failures or blockers."
} as const

export const MONITOR_VERDICT_RULE =
  "End each run with its verdict: call `report` with event `news` and the finding when something qualifies, or with event `no_change` and the evidence checked when nothing does. A brief, digest or reminder the user asked for is news. When this Automation runs again on its own, a run that declares no news and changes nothing shows the user no line; its reply stays in its own chat."
