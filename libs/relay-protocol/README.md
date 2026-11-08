# `@arden-hq/relay-protocol`

The wire format between a Mac, the relay and a phone. It has the frame format, the header messages, the end-to-end crypto and the app messages. `@arden-hq/server` (the Mac side) and `apps/relay` import it. The iOS app has its own Swift version of the same format. `test-vectors.json` holds fixed examples (published in the package) that other implementations can check against.

The relay sees only sealed frames. It cannot read app messages.

## Exports

- Frames: `encodeFrame`, `decodeFrame`, `FRAME_VERSION`, `MAX_FRAME_BYTES`.
- Headers: `parseClientHeader`, `parseRelayHeader`, `CloseCode` and one type for each header message (pairing, presence, queueing, push).
- Identity: `generateEd25519`, `sign`, `verify`, `deviceId`, `pairCode`, `pairTokenHash` and the signed messages for auth and for adding or removing a device.
- Session crypto: `generateX25519`, `macSessionKeys`, `phoneSessionKeys`, `SessionCipher`, `sealQueued`, `openQueued`.
- App messages: `encodeAppMessage`, `decodeMacMessage`, `decodePhoneMessage`, `decodeHandshake`. `PartAssembler` joins messages that were split into parts.
- Encoding helpers: base64url, hex and UTF-8.

## Rules

- Do not change a format without a new version. A phone in the field must still work.
- Every format change must update `test-vectors.json`. Run `scripts/generate-test-vectors.ts` to write it. Change the Swift version in the app repo in the same step.
- Only the Mac and the phone hold session keys. Never add a key or plain text to a header.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
