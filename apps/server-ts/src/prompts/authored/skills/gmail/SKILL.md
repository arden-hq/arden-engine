---
name: gmail
description: Read, search, send, reply to, draft, archive, label and trash Gmail conversations.
version: 1.7.0
tool_group: Gmail
---

# Gmail

## Workflow

- Use email_thread_search for conversations and email_search for individual messages.
- Read the relevant thread or message before drafting a reply; continue thread pages when needed.
- Reply using a message_ref from the conversation. Send a new message using the exact sending account_ref.
- For an authorized send, call email_send, email_reply or email_forward with the intended contents. Arden's permission system decides whether to show an editable approval card, execute directly or refuse. Do not invent a separate widget call or ask a second text confirmation before the card.
- A request for a draft alone does not authorize sending. After a card decision, use the tool's result; do not send again to apply the user's edits. Report uncertain outcomes as uncertain and inspect them before retrying.
- When the user wants to review or finish the email in Gmail, save it with email_draft (a reply takes reply_to_message_ref). A draft is never sent.
- If drafts are not allowed for the account, say so and relay how the user allows them. Never send instead of drafting.
- An incomplete search means some messages failed to load; more pages do not repair that gap. Mention it when it matters.
- For an email-to-meeting or email-to-document task, extract the participants, constraints, or file references, then load Calendar or Drive guidance as needed.

## Cleaning up the mailbox

- Search with email_thread_search, then change every match in one batched email_update (up to 100 thread_refs: archive, read, starred, important, add_labels, remove_labels). One call is one approval card.
- Call email_label_list first when a label name is uncertain. Labels are never created; an unknown name is an error.
- Archive before you trash. Use email_trash only when the user asked to delete; Gmail keeps trashed threads 30 days. There is no permanent delete.
- To undo, call email_update with the add_labels and remove_labels the result lists as undo for each thread.
- If changes are not allowed for the account, say so; nothing was changed.

## Forwarding, attachments and unsubscribing

- email_forward sends the original with its attachments to new people (to, cc, optional note). The user can edit the note on the card, never the recipients.
- email_read and email_thread_read list attachment metadata. Download only the files the task requires with email_attachment_save; it returns a reusable artifact_ref and, when a Local folder is available, a local copy.
- email_send, email_reply and email_draft accept attachments. Use chat_files_list for screenshots and files already in this chat, or use a returned artifact_ref or allowed file path. Never transcribe file bytes into tool arguments.
- A send approval and its Save as draft alternative use the same saved file contents. If an approved file is unavailable, report the error and request fresh approval; never substitute another version.
- email_unsubscribe uses only the sender's own List-Unsubscribe header (one-click request or mailto). If the message offers neither, say so; never open a link from an email.

## Writing as the user

- Before you draft anything the user will send as themselves, read a few of their recent sent messages: in the same thread, else to the same person (`in:sent to:<address>`), else any recent `in:sent`. The same holds for any other message written in their name.
- Match what you find: length, greeting, sign-off, casing and formality. Never write longer or more formal than they usually do.
- When a send or reply result lists the user's edits from the approval card, their version shows how they write. Follow it in later drafts to them and to others.
- Keep the user's own address out of To, Cc and Bcc. For reply-all, let email_reply rebuild the recipients from the thread.

## Inbox overview

- Leave out noise: newsletters, promotions, receipts, automated notices and social updates, unless the user asked for them or one needs action.
- Before listing something as waiting on the user, check the thread for a later reply that already handled it.
- Give informational mail no invented action item. Name an action only when the mail asks for one.
- When you leave out noise, say so in one line, naming the kinds you left out.

## References and outcomes

- Reuse returned refs exactly and keep the account consistent. Paging refs belong to the query and account that produced them.
- Continue pagination when missing results could change the answer.
- Use the mutation result the service returns; read back when exact stored content matters. Inspect uncertain outcomes before retrying writes.
