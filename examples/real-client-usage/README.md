# Real Client Usage (Core Protocol)

These are production-style integration examples (not demo test harnesses).

They show how a real app wires:
- transport (`WebSocket`),
- storage (`SQLite`),
- core sync client lifecycle (`connect -> sync -> submit -> apply`).

## Files

- `common/createWebSocketTransport.js`
- `common/createSqliteStore.js`
- `common/createCoreSyncClient.js`
- `scenario-01-online-edit-and-live-sync.js`
- `scenario-02-offline-first-reconnect-drain.js`
- `scenario-03-crash-recovery-sync-first.js`
- `scenario-04-rejection-ui-feedback.js`

## Notes

- Uses `better-sqlite3` in examples for concrete persistence shape.
- Uses browser-style `WebSocket`; for Node/React Native/Electron replace transport impl only.
- Aligns with simplified protocol docs under `docs/protocol/*.md`.

## Typical app wiring

```js
const client = createCoreSyncClient({
  transport,
  store,
  token,
  clientId,
  partitions: ["workspace-1"],
  onEvent: ({ type, payload }) => {
    // update UI/reactive state
  },
});

await client.start();
await client.submitEvent({ partitions: ["workspace-1"], event });
```
