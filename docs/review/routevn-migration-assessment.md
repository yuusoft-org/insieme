# RouteVN Migration Assessment

Scope: read-only review of `/home/han4wluc/repositories/RouteVN/routevn-creator-client` against this Insieme branch. No RouteVN files were changed.

## RouteVN integration points

- Web clients use `createCommandSyncSession` and `createIndexedDbClientStore`.
- Tauri clients use `createLibsqlClientStore` through a local `project.db`.
- The local sync server uses `createSqliteSyncStore` with `better-sqlite3`.
- RouteVN application code expects public committed events with enumerable flat fields such as `committedId`, `projectId`, `partition`, `type`, `schemaVersion`, `payload`, and `serverTs`.

## Breaking risks found

1. Public committed-event shape could be lost after JSON or `structuredClone`.
   The new internal stored-event shape uses non-enumerable aliases for old flat fields. RouteVN clones committed events before cursor/dedupe handling, so non-enumerable aliases were not durable enough for RouteVN.

2. Existing SQLite databases used the old flat schema.
   RouteVN's documented server/client schemas and Insieme 2.1.0 stores use flat columns. This branch moved SQLite storage to `client_id`, `partitions`, `event`, and timestamp columns. Without migration, critical SQLite users could see reset-required failures or data loss pressure.

## Fixes in this branch

- Added public committed-event materialization before sync-server wire responses, sync-client events, and command-session callbacks.
- Added SQLite sync-store migration from flat `committed_events` rows to the new internal event schema.
- Added SQLite/libSQL client-store migration from flat `local_drafts` and `committed_events` rows to the new internal project-store schema.
- Added regression tests using RouteVN-style flat schemas and JSON/stored-shape events.

## Migration benefit

RouteVN can keep using the simpler command/session API while Insieme owns internal storage normalization, partition scoping, idempotency, cursor monotonicity, and replay behavior. Existing SQLite data is now treated as a migration input, not as a reset condition.

## Remaining guidance

- SQLite is now covered by RouteVN-shaped migration fixtures and the hard multi-client simulation.
- IndexedDB remains lower priority per current direction, but browser users still rely on it for web local state.
- For production rollout, run the migration against a copy of representative RouteVN `project.db` and `routevn-sync.db` files before updating the app dependency.
