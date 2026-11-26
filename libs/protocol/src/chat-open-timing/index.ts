export const CHAT_OPEN_TIMING_REQUEST_HEADER = "x-arden-chat-open-timing"
export const CHAT_OPEN_TIMING_RESPONSE_HEADER = "server-timing"
export const CHAT_OPEN_TIMING_REQUESTED = "1"

export const CHAT_OPEN_SERVER_TIMINGS = [
  "resume_follower",
  "resume_capture_queue",
  "resume_history",
  "resume_active_projection",
  "resume_initial_projection",
  "resume_durable_range",
  "resume_final_projection",
  "resume_total"
] as const

export type ChatOpenServerTiming = (typeof CHAT_OPEN_SERVER_TIMINGS)[number]
