export const newChat = (
  input: { readonly name?: string; readonly spaceId?: string; readonly model?: string } = {}
) => ({
  name: input.name === undefined ? { kind: "unnamed" } : { kind: "named", name: input.name },
  space:
    input.spaceId === undefined ? { kind: "none" } : { kind: "space", space_id: input.spaceId },
  chat_model:
    input.model === undefined ? { kind: "inherited" } : { kind: "pinned", model_id: input.model },
  origin: "ordinary"
})
