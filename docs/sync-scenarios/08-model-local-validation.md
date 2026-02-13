# Scenario 08 - Model/Domain Local Validation

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Ensure invalid model events are rejected locally before insert/send.

## Actors
- C1
- Server (not reached)

## Preconditions
- Client is running in model/domain mode.
- Model schemas are registered locally.

## Steps

### 1) C1 attempts to create a model event

**Event**
```yaml
type: event
payload:
  schema: branch.create
  data:
    name: 123
```

### 2) Local validation fails
- Schema expects `name` as string; received number.

### 3) Client behavior
- Do not insert draft row.
- Do not send `submit_events` to server.
- Surface validation error locally.

## Expected Results
- No DB insert.
- No network call.
- No draft overlay changes.

## Assertions
- Local validation errors are deterministic and match schema.
