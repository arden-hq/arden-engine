import type { Migration } from "./index.js"

export const spaceReviewChatsSessionIndex: Migration = {
  version: 182,
  name: "space_review_chats_session_index",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      "CREATE INDEX idx_space_review_chats_session_id ON space_review_chats(session_id)"
    )
}
