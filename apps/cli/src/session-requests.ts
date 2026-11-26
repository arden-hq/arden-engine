import {
  BRANCH_REQUEST,
  PARENT_MESSAGE,
  SESSION_MODEL,
  SESSION_NAME,
  SESSION_ORIGIN,
  SESSION_SPACE,
  type BranchSessionRequest,
  type CreateSessionRequest
} from "@arden-hq/protocol/sessions"

export const newChat = (input: {
  readonly spaceId: string | undefined
  readonly model: string | undefined
}): CreateSessionRequest => ({
  name: { kind: SESSION_NAME.unnamed },
  space:
    input.spaceId === undefined
      ? { kind: SESSION_SPACE.none }
      : { kind: SESSION_SPACE.space, space_id: input.spaceId },
  chat_model:
    input.model === undefined
      ? { kind: SESSION_MODEL.inherited }
      : { kind: SESSION_MODEL.pinned, model_id: input.model },
  origin: SESSION_ORIGIN.ordinary
})

export const wholeFork: BranchSessionRequest = {
  disposition: "retained",
  request: { kind: BRANCH_REQUEST.once },
  share_resources: false,
  name: { kind: SESSION_NAME.unnamed },
  up_to: { kind: PARENT_MESSAGE.whole }
}
