---
name: drive
description: Find, transfer and share Drive files, and read and edit Google Docs and Sheets.
version: 1.1.0
tool_group: Drive
---

# Drive

## Workflow

- Resolve a file with drive_search. For Docs, list tabs when the target is unclear; for Sheets, read the smallest useful A1 range.
- Populate newly created Docs with drive_edit_doc; use exact-range updates or table appends for Sheets.
- Read the target before replacing Doc text and use its exact case-sensitive match.
- Choose USER_ENTERED for UI-style parsing and RAW for literal Sheet values.
- incomplete_search means the index was not fully scanned; paging cannot repair it.
- For document-to-email work, read the source first, then load Gmail guidance for the requested communication.
- drive_search lists metadata for all file types. Download ordinary files with drive_download; export native Docs, Sheets or Slides with drive_export and an explicit format. Both return reusable artifact_ref values without putting binary contents in the model context.
- Use chat_files_list to find chat screenshots and saved files. drive_upload takes one file reference and a stable operation_key. Reuse that key when retrying the same upload, including after an uncertain outcome; changing the key starts a new upload and can create a duplicate.
- drive_share_file grants one named person read or edit access. Uploading or attaching a file to Calendar never grants access automatically. Ask for the required Google permission when the tool requests it.

## References and outcomes

- Reuse returned refs exactly and keep the account consistent. Paging refs belong to the query and account that produced them.
- Continue pagination when missing results could change the answer.
- Use the mutation result the service returns; read back when exact stored content matters. Inspect uncertain outcomes before retrying writes.
