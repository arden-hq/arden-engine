export type NewChatBody = {
  readonly name: { readonly kind: "unnamed" } | { readonly kind: "named"; readonly name: string }
  readonly space: { readonly kind: "none" } | { readonly kind: "space"; readonly space_id: string }
  readonly chat_model:
    | { readonly kind: "inherited" }
    | { readonly kind: "pinned"; readonly model_id: string }
  readonly origin: "ordinary"
}

export const newChat = (
  input: { readonly name?: string; readonly spaceId?: string; readonly model?: string } = {}
): NewChatBody => ({
  name: input.name === undefined ? { kind: "unnamed" } : { kind: "named", name: input.name },
  space:
    input.spaceId === undefined ? { kind: "none" } : { kind: "space", space_id: input.spaceId },
  chat_model:
    input.model === undefined ? { kind: "inherited" } : { kind: "pinned", model_id: input.model },
  origin: "ordinary"
})
