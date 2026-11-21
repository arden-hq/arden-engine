# Arden engine

The open-source agent server behind [Arden](https://fromarden.com).

## Get started

You need [Bun](https://bun.sh), [just](https://just.systems) and Node.js 22.16 or later.

```bash
bun install
just build
```

Sign in with your ChatGPT account:

```bash
just arden login
```

Send a prompt:

```bash
just arden "Say hello"
```

To keep a server running, start it in one terminal:

```bash
just arden serve
```

Prompts from other terminals then go to it:

```bash
just arden "What can you do?"
```

Settings and data live in `~/.arden-cli`.

## Docs

- [CLI](apps/cli/README.md): every command
- [Server](apps/server-ts/README.md): settings, local models, OpenRouter, embedding
- [Agent loop](libs/loop/README.md)
- [API](libs/protocol/README.md)
- [Contributing](CONTRIBUTING.md)

Licensed under [Apache-2.0](LICENSE).
