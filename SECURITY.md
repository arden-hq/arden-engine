# Security

Arden runs on your own computer and can read files, run commands and use your
accounts. We take reports about it seriously.

## Report a problem

Do not open a public issue. Report it privately on GitHub: open the
**Security** tab of `arden-hq/arden-engine` and choose **Report a
vulnerability**.

Please include:

- what an attacker can do, and what they need first (for example a web page
  the agent opens, a file it reads, or access to the relay);
- the steps or a small script that shows it;
- the engine version or commit.

We reply within 7 days and tell you when a fix ships.

## In scope

- The agent server (`apps/server-ts`): permission rules, approvals, the local
  HTTP API, storage.
- Prompt injection that gets the agent past a permission rule or an approval.
- The relay and its end-to-end encryption (`apps/relay`,
  `libs/relay-protocol`).
- The CLI and the libraries under `libs/`.

## Out of scope

- Something the agent does after you approved it, or that your own rules
  allow.
- Attacks that need control of your user account on the machine.
- The model provider's own service.
