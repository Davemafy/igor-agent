# Engine-to-frontend integration contract (v1)

**Status:** implementation candidate, not a claim of live provider acceptance.

The new Igor frontend is developed independently from the agent branch. This
contract exposes one **derived, owner-scoped read model** for the work the engine
has *actually persisted*. It neither replaces the existing Task/WorkState
schema nor introduces a new write path.

## Read a workspace

Authenticated endpoint:

`GET /api/tasks/:workspaceId/snapshot`

- Existing session cookie required; 401 for missing session, 404 for an
  inaccessible or missing workspace.
- Response: `WorkspaceSnapshotSchema` in
  `src/core/workspace-snapshot.ts`, `schemaVersion: 1`.
- `Cache-Control: private, no-store`; `X-Igor-Contract-Version: 1`.
- `revision` is the same authoritative optimistic concurrency version as
  `task.brief.version`.
- IDs are server-owned and unchanged from the canonical Task. A frontend must
  not invent candidate IDs, evidence IDs, tool states or scores.

The response contains these *semantic* sections, not screen-specific payloads:

- `conversation`: canonical messages and focus for chat and recovery.
- `participants`: brief-owned people and consented preferences.
- `discovery`: raw catalogue, evaluated candidates, entities and evidence.
- `spatial`: grounded places and geocoded IDs for 2D/3D maps.
- `plan`: selected candidates, schedule, and canonical WorkState.
- `artifacts`: current documents and version history.
- `execution`: agent run, history, trace, failures, and partial work.

For maps, only IDs in `spatial.geocodedPlaceIds` are eligible to become real
pins. Items with no coordinates, or illustrative sample items, must not become
real-world map markers. An item with coordinates is **not** proof of opening
hours, booking availability or price.

Cultural affinities, ranks and explanations retain their **original
query/participant scope**. Do not promote aggregate query results into
per-person scores. Evidence records include provenance and limitations.
Likewise `plan.work.externalActions` currently contains **blocked**
operations, not successful messages or bookings.

## Streaming and writes remain on the existing API

The snapshot is a read projection; it never executes the agent.

1. Use the existing authenticated `POST /api/tasks/:id/turn`, with a stable
   `clientTurnId`, expected version, and user action.
2. Consume SSE messages (`state`, `action`, `done`, `error`) and persist
   the returned event cursor. Do not treat a transient stream frame as a
   committed final artifact.
3. After an interrupted connection, use the existing **GET** turn-journal
   endpoint with `turnId` and `after` cursor. Do **not** resubmit the POST to
   recover a completed action.
4. Refresh this snapshot after a saved state change, including a revision.
   Use `revision` to reject stale visual updates.
5. Existing `work` and `artifact` turns remain authoritative for approvals,
   edits and revisions. This snapshot is not a second client-side state store.

## Compatibility guarantees

- This is additive. Existing `/api/tasks/:id` and turn endpoints remain
  unchanged, as do the independent UI branch and persistence layout.
- If the response evolves incompatibly, increment `schemaVersion` and retain
  a v1 compatibility path or coordinate frontend adoption.
- Do not remove fields from canonical provider evidence to make prettier cards.
- The frontend renders semantic data with its own responsive components; the
  engine does not generate JSX or route by screenshot/screen number.
- Never infer that a feature is live merely because a suitable component can
  render its record.

## Verification and remaining work

`tests/unit/workspace-snapshot.test.ts` covers version compatibility,
canonical version/ID retention, edited artifact stability, sample/unknown
coordinates, empty evidence and blocked external actions.

This contract **does not** prove:

- Live Qloo-to-composed-artifact completion.
- Healthy model/provider decisions.
- External email sending or signed asynchronous inbound reply handling.
- Google Maps/3D renderer implementation.
- Authenticated end-to-end browser integration of the separate UI.
- Railway storage and restoration behavior.

These require separate exact-commit deterministic CI, authorized live-provider
runs and eventual frontend integration tests. Do not merge or deploy before
those gates and owner review.
