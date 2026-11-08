/**
 * The optional argument through which a model titles one tool call for the
 * UI. The server advertises it on every tool schema; the loop strips it before
 * validation, sanitizes it and stores it as the call's `display_title`.
 */
export const TOOL_DISPLAY_TITLE_ARGUMENT = "_display_title"

/** The display title's cap, in code points. */
export const MAX_TOOL_DISPLAY_TITLE_LENGTH = 120
