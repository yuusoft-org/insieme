# Scenario 13 - Retry While Local Draft Is Still Pending

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify idempotent retry handling when the client did not receive the original `submit_events_result` and the local row is still `status=draft`.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- C1 submitted event `evt-uuid-r1` to the server.
- Server already committed it at `committed_id=410`.
- C1 never received the `submit_events_result` response (network interruption).
- C1 local DB still has:
  - `id=evt-uuid-r1`, `status=draft`, `committed_id=NULL`, `draft_clock=5`

## Steps

### 1) C1 reconnects and retries submit_events (same id)

After reconnecting, C1 retries all pending drafts in `draft_clock` order.

**C1 -> Server**
```yaml
type: submit_events
payload:
  events:
    - id: evt-uuid-r1
      partitions:
        - P1
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: X
          options:
            parent: _root
            position: first
```

### 2) Server dedupes by id

- Lookup by `id` returns existing committed row with `committed_id=410`.
- Payload matches the original submission.
- Does not create a new commit.

**Server -> C1** (replay commit result)
```yaml
type: submit_events_result
payload:
  results:
    - id: evt-uuid-r1
      status: committed
      committed_id: 410
      status_updated_at: 1738451500000
```

### 3) C1 upgrades local draft

C1 applies the upsert strategy (UPDATE by `id`):

```
id=evt-uuid-r1
committed_id=410
status=committed    (was draft)
status_updated_at=1738451500000
draft_clock=5       (unchanged, now irrelevant)
```

### 4) C1 recomputes local view state

- committed(P1) includes evt-uuid-r1 at committed_id=410.
- Draft overlay no longer includes evt-uuid-r1.

## Assertions
- No new commit is created on server (committed_id sequence does not advance).
- Local row transitions `draft -> committed` via UPDATE by `id` (no duplicate row).
- Upsert strategy handles draft-to-committed upgrade correctly.
- If C1 also receives the event via sync catch-up, the `ON CONFLICT(committed_id) DO NOTHING` prevents duplicates.
