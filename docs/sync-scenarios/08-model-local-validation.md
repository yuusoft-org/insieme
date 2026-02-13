# Scenario 08 - Local Validation Gate

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify local validation prevents obviously invalid drafts from being queued.

## Actors
- C1

## Preconditions
- C1 has local validator for active app event mode.

## Steps

### 1) Invalid local event
- User action generates invalid payload (missing required field).
- Local validator rejects before insert.

### 2) Valid local event
- User action generates valid payload.
- Client inserts into `local_drafts` and sends `submit_events`.

## Assertions
- Invalid event is not inserted into `local_drafts` and not submitted.
- Valid event follows normal draft -> submit -> result flow.
- Server validation remains authoritative even when client pre-validates.
