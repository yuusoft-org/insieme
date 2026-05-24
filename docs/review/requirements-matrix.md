# MUST/SHOULD Requirement Matrix

Review date: May 21, 2026

Status values:
- `implemented`: behavior exists and verified by tests
- `gap`: no implementation/test mapping yet

| Req ID | Source | Requirement | Priority | Planned Tests | Target Modules | Status |
|---|---|---|---|---|---|---|
| PR-001 | `docs/protocol/messages.md:9` | Envelope includes `type`, `payload`, `protocolVersion`. | must | `SC-00`, `SC-18` | server protocol handler | implemented |
| PR-002 | `docs/protocol/messages.md:22` | Unknown message type -> `bad_request`. | must | `SC-18` | server protocol handler | implemented |
| PR-003 | `docs/protocol/messages.md:23` | Missing envelope fields -> `bad_request`. | must | `SC-18` | server protocol handler | implemented |
| PR-004 | `docs/protocol/messages.md:24` | Unsupported protocol version -> `protocolVersion_unsupported` and close. | must | `SC-18` | server connection lifecycle | implemented |
| PR-005 | `docs/protocol/messages.md:25` | Unknown extra fields ignored. | must | `SC-18` | server validation boundary | implemented |
| PR-006 | `docs/protocol/messages.md:submit_events` | `submit_events.payload.events` contains one or more items in core mode. | must | `SC-01`, `SC-02`, `SC-16`, `SC-18` | server submit handler | implemented |
| PR-007 | `docs/protocol/messages.md:submit_events_result` | Exactly one `submit_events_result` is returned per `submit_events` request. | must | `SC-01`, `SC-02`, `SC-03`, `SC-16` | server submit handler | implemented |
| PR-008 | `docs/protocol/messages.md:submit_events_result` | `submit_events_result.results` contains one entry per submitted item in request order; later items after a failure are `not_processed`. | must | `SC-01`, `SC-02`, `SC-16` | server submit handler + client draft apply path | implemented |
| PR-009 | `docs/protocol/messages.md:187` | No self-broadcast to submitting connection. | must | `SC-10` | server broadcast fanout | implemented |
| PR-010 | `docs/protocol/messages.md:217` | If `hasMore=true`, client re-syncs with `nextSinceCommittedId`. | must | `SC-05` | client sync engine | implemented |
| PR-011 | `docs/protocol/messages.md:219` | `sync_response.payload.projectId` reflects the active project scope and `syncToCommittedId` remains fixed during a paging cycle. | must | `SC-05`, `SC-12`, partition-filtered pagination regression | server sync response builder | implemented |
| PR-012 | `docs/protocol/connection.md:16` | Before handshake, only `connect` accepted. | must | `SC-00`, `SC-18` | server connection lifecycle | implemented |
| PR-013 | `docs/protocol/connection.md:18` | Valid `connect` -> `connected` + state transition to active. | must | `SC-00` | server connection lifecycle | implemented |
| PR-014 | `docs/protocol/connection.md:19` | Auth failure -> `auth_failed` + close. | must | `SC-18` | server auth boundary | implemented |
| PR-015 | `docs/protocol/connection.md:55` | Authenticated `clientId` must match `connect.payload.clientId`. | must | `SC-18` | server auth boundary | implemented |
| PR-016 | `docs/protocol/connection.md:58` | Submit and sync requests must use the authenticated session `projectId`. | must | `SC-04`, `SC-12`, `SC-18` | server authz boundary | implemented |
| PR-017 | `docs/protocol/connection.md:59` | Token expiry mid-connection -> `auth_failed` + close. | must | dedicated connection-expiry test | server connection lifecycle | implemented |
| PR-018 | `docs/protocol/connection.md:75` | Reconnect sequence is `connect` then `sync`. | must | `SC-05`, `SC-17` | client sync engine | implemented |
| PR-019 | `docs/protocol/ordering-and-idempotency.md:9` | `committedId` globally monotonic and never reused. | must | `SC-03`, `SC-15` | server commit allocator | implemented |
| PR-020 | `docs/protocol/ordering-and-idempotency.md:15` | Server dedupes by event `id`. | must | `SC-03`, `SC-13` | server submit/dedupe path | implemented |
| PR-021 | `docs/protocol/ordering-and-idempotency.md:16` | Same `id` + same payload returns existing committed result. | must | `SC-03`, `SC-13` | server dedupe path | implemented |
| PR-022 | `docs/protocol/ordering-and-idempotency.md:17` | Same `id` + different payload rejected (`validation_failed`). | must | `SC-09` | server dedupe validation | implemented |
| PR-023 | `docs/protocol/ordering-and-idempotency.md:39` | Canonicalization is deterministic and consistent. | must | `SC-03`, `SC-09` + unit tests | server canonicalizer | implemented |
| PR-024 | `docs/protocol/ordering-and-idempotency.md:55` | Client apply path is idempotent across submit/sync/broadcast. | must | `SC-06`, `SC-10`, `SC-13` | client store/runtime | implemented |
| PR-025 | `docs/protocol/partitions.md:17` | Committed events carry a non-empty normalized partition set; legacy singular `partition` submit input is accepted and rewritten. | must | `SC-04`, `SC-18`, stored-shape compatibility tests | request normalization + store adapters | implemented |
| PR-026 | `docs/protocol/partitions.md:19` | Submitted application partitions must not include a foreign `project:<id>` scope. | must | foreign project-scope submit test | request validation | implemented |
| PR-027 | `docs/protocol/partitions.md:12` | Server adds the authenticated project scope before commit and normalizes accepted partition sets deterministically. | must | `SC-04` + canonicalization unit tests | request normalization | implemented |
| PR-028 | `docs/protocol/partitions.md:27` | `sync.payload.partitions` with a foreign project scope -> `forbidden`. | must | `SC-18`, foreign sync partition test | authz boundary | implemented |
| PR-029 | `docs/protocol/validation.md:9` | Server validates every submitted event before commit. | must | `SC-02`, `SC-08`, `SC-18` | server validation pipeline | implemented |
| PR-030 | `docs/protocol/durability.md:22` | Commit order: assign id -> durable persist -> reply/broadcast. | must | `SC-15` | server commit transaction | implemented |
| PR-031 | `docs/protocol/durability.md:40` | Persist final sync cursor at `hasMore=false` (intermediate optional). | must | `SC-05`, `SC-17` | client store/runtime | implemented |
| PR-032 | `docs/protocol/durability.md:46` | During active sync cycle, no broadcasts to that connection. | must | `SC-05`, `SC-17` | server subscription delivery | implemented |
| PR-033 | `docs/protocol/durability.md:53` | No committed result/broadcast before durable persist. | must | `SC-15` | server durability boundary | implemented |
| PR-034 | `docs/protocol/durability.md:71` | Sync limit clamped to server bounds. | must | dedicated sync-limit test | server sync handler | implemented |
| PR-035 | `docs/client/drafts.md:23` | Draft submit order is `(draft_clock, id)`. | must | `SC-16`, `SC-11` | client queue + store | implemented |
| PR-036 | `docs/client/storage.md:136` | Any committed arrival path inserts committed and removes matching draft idempotently. | must | `SC-01`, `SC-05`, `SC-10` | client store adapter | implemented |
