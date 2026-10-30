# Engine and frontend integration contract v1

**Status:** Implemented read-only contract. Live provider acceptance is pending.

Igor's frontend is developed independently from the engine.
This contract exposes existing persisted work without a second state store.
The server owns all IDs, revisions, authorization, evidence and execution.

## Read a workspace

Endpoint: `GET /api/tasks/:workspaceId/snapshot`

- Authentication: existing session cookie.
- Missing session: HTTP 401.
- Missing or inaccessible workspace: HTTP 404.
- Content: `WorkspaceSnapshotSchema` from `src/core/workspace-snapshot.ts`.
- Version: `schemaVersion: 1` and `X-Igor-Contract-Version: 1`.
- Cache policy: `private, no-store`.
- Concurrency: `revision` equals the canonical `task.brief.version`.

## Semantic data

- `conversation`: saved messages and current conversation focus.
- `participants`: brief-owned people and explicit preferences.
- `discovery`: raw catalogue, evaluated candidates, entities and evidence.
- `spatial`: real place candidates and geocoded place identifiers.
- `plan`: current selections, schedule and canonical WorkState.
- `artifacts`: editable outputs and historic versions.
- `execution`: current run, archived runs, trace, warnings and errors.

Use the same snapshot across Home, Discover, Conversation, Plan, Maps,
Create, Compare, Library, Details, Revise and Mobile.
The server does not route by screen or output JSX.

## Evidence rules

- Never invent affinity, ratings, source IDs, prices or availability.
- Cultural signals retain the provider's real query or participant scope.
- An aggregate result is not a per-person taste score.
- Evidence includes provenance, freshness and source limitations.
- Only IDs in `spatial.geocodedPlaceIds` qualify as map pins.
- A real coordinate does not prove opening hours or a bookable slot.
- Illustrative sample places are not eligible as real map pins.
- `plan.work.externalActions` currently records blocked actions.
- A blocked action is not proof of a sent email or reservation.

## Streaming and mutations

Keep all writes on the existing authenticated task-turn endpoints.
The snapshot is strictly read-only.

1. POST to `/api/tasks/:id/turn` with a stable `clientTurnId`.
2. Include the current optimistic concurrency version.
3. Consume validated `state`, `action`, `done` and `error` SSE events.
4. Retain the event cursor and follow saved state after revisions.
5. On disconnection, GET the existing turn journal by ID and cursor.
6. Never repeat the POST to recover a completed external operation.

Approvals, edits and revisions stay in the existing work and artifact turns.
Reject stale visual updates based on the canonical revision.
Keep evidence and artifacts linked by their existing identifiers.

## Compatibility

The contract is additive and leaves these APIs unchanged:

- `/api/tasks/:id`
- `/api/tasks/:id/turn`

An incompatible snapshot change requires a new schema version.
Maintain v1 compatibility or coordinate adoption with the UI team.
Neither the independent UI branch nor the SQLite store is changed.

## Verification

See `tests/unit/workspace-snapshot.test.ts` for projection regressions.
Tests cover versions, canonical IDs, edited artifacts, evidence provenance,
unknown availability, raw place candidates and grounded map pins.

Separate acceptance is still required for:

- Live Qloo discovery through saved documents and revision.
- Healthy real-model decisions and source-grounded research.
- Authorized external writes, AgentMail delivery and inbound replies.
- Authenticated browser integration with the independent UI.
- Railway persistence, backups, rollback and production revision.

Do not merge or deploy before exact-commit CI and owner review.
Deterministic tests do not establish live provider or production readiness.
