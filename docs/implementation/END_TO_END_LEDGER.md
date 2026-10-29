# End-to-end implementation ledger

Baseline inspected: `64615cf48adb7092654ce5b9ad6a48e1d71ecd86`, PR #27,
`feat/partiful-codrops-unified-20261029`. The source is newer than the mission's
prepared baseline. No old branch or rejected visual system is being restored.

| Area                              | Baseline                                                   | Current action / evidence                                                             |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Accepted messages / dedupe        | Implemented; no initial journal event                      | Add atomic first event, lease identity and late-worker fence                          |
| Run lifecycle / reconnect         | Partial; interruption inferred from age                    | Persist expired-lease recovery, partial/input states, SSE IDs and paginated snapshots |
| Conversation focus                | Partial; ordered IDs, limited references                   | Inspect revision-bound references and supplied assumptions next                       |
| Single runtime / Qloo / TrueForge | Existing bounded loop + capabilities; delegation opt-in    | Reuse adapters; independent live acceptance requires credentials                      |
| Experience graph / critique       | General decisions/documents; incomplete cross-domain model | Add typed, evidence-bound composition within current WorkState                        |
| Product / regression              | Partiful/Codrops retained; native invite CI red            | Fix fixture DB binding without weakening the no-placeholder assertion                 |
| CI / live / hosting               | Last external CI red; volume/live prerequisites unverified | Use qloo-test exact SHA; no deployment or secret changes                              |

## Foundation implementation

- Admission, user message, lease identity and first journal event share one SQLite
  transaction. No external inference occurs inside it.
- Additive migrations preserve existing tasks and old journal rows. A 60-second
  worker lease is renewed by the live request heartbeat. After a database reopen,
  expired work is durably marked interrupted, preserving messages and checkpoints.
  This is interruption recovery, not automatic paid-tool resumption.
- Every API worker saves through an owner/workspace/run-scoped lease fence and
  the existing optimistic version guard. Accepting a newer correction supersedes
  prior runs; late workers cannot commit after lease expiry or supersession.
- Existing SSE action/state/done/error packet types remain. New action metadata
  records actual phases; live delivery and replay use stable ordered event IDs.
  Journal reads return an authoritative snapshot, last cursor and pagination flag.
- The browser retains only pending turn identity/cursor, can restore saved events
  after reload, and does not replay POST or paid operations to recover a connection.
- Inherited native-invite failure was a fixture binding error: the test wrote to
  `.igor/integration-browser`, while its server uses `.igor/e2e/recorded`. The
  corrected setup asserts exactly one fixture row was updated. UI behavior and
  the original no-placeholder assertions remain intact.

## Verification so far

- Foundation/stream/fetch unit tests: 22 passed locally.
- Local broad unit attempt: 475 passed; six suites blocked by the original
  `qloo-cultural.json.gz` being unavailable through the local connector. No
  synthetic replacement was created; qloo-test must check the original archive.
- Typecheck passes. Final CI/browser/live results will be recorded at their exact
  source SHA. No local model, Qloo or TrueForge credential binding is available.

## Integrated experience graph

- Extend the existing WorkState schema with optional typed domains, rationale
  kinds, candidate bindings, alternatives, schedules and alcohol restrictions.
  Old saved work remains readable. No new runtime or database is introduced.
- `experience.compose` writes actual connected decisions and editable documents;
  `experience.critique` independently checks budgets, schedule collisions,
  current query/candidate evidence, cultural domain misuse, alcohol constraints,
  dependency coherence and practical unknowns. Hard issues block completion.
- The agent acceptance boundary reads those same documents (no duplicate artifact
  store), checks interpreted domain requirements and retains LIVE/CACHED/RECORDED
  evidence provenance. Internal work does not consume provider request budget.
- Budget-only correction reevaluates the saved candidate pool without Qloo calls.
  Approved decisions and manual wording survive selective invalidation. Fixed a
  double-invalidation bug that made newly recomputed decisions stale and a budget
  warning that incorrectly modified zero-cost, unrelated decisions.
- Focus no longer revives stale choices through a catalogue fallback. Current
  replies cannot cite stale evidence. Saved focus includes goal, decisions, open
  questions, unresolved assumptions and explicitly confirmed preference IDs.

## Architecture-to-code map

| Contract                                     | Implementation                                                | Regression evidence                                            |
| -------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Admission, lease, fencing, recovery          | `src/data/store.ts`, `src/core/turn-lifecycle.ts`, turn route | durable-turn, turn-recovery, turn-reconnect                    |
| Ordered progress and reconnect               | turn route, workspace-api, use-workspace                      | workspace-stream, turn-reconnect                               |
| Interpretation and focus                     | interpret-message, conversation-focus, model-context          | conversation-reply, conversation-focus, interpretation-failure |
| Bounded composition and acceptance           | unified-agent, agent-tool-registry, agent-acceptance          | unified-agent, agent-acceptance, experience-graph              |
| Connected decisions and independent critique | work-contracts, connected-work, experience-critique, revision | connected-work, experience-graph                               |
| Existing product rendering                   | connected-work-canvas                                         | connected-work browser suites                                  |

Local graph/focus/acceptance checks: 51 passed. Broad local run: 486 passed;
six suites blocked solely by the unavailable original cultural archive. This is
not a passing full suite. Typecheck passes; lint has 0 errors (27 existing warnings).
The new two-goal engine tests use explicitly mocked query evidence; they are not
live Qloo demonstrations. External exact-head checks remain pending.

Live model/Qloo and TrueForge are BLOCKED locally: no authorized binding is
present. Railway volume mounting and backup/restore are unverified because this
session has no hosting access. No production deployment or secret change occurred.

## Live execution boundary diagnosed

At source `497e62f`, bounded authorized live acceptance resolved all three anchors
and completed `qloo.discover` (4 provider requests). It then failed at the next
model decision with safe category `provider timeout`; no action was selected or
artifact saved. Acceptance remains FAILED, not a Qloo-resolution success claim.
The chooser forced a 15-second transport deadline despite Gemini's configured
80-second outer limit. It now uses the configured limit less a 5-second margin,
with no automatic retry or increased request count. A fake-clock regression
reproduces a valid composition response at 16 seconds in one request. The argument
JSON envelope also permits the already-declared 12k document size plus metadata;
actual tool argument, source and permission schemas remain unchanged.

Paid-read exhaustion now removes paid tools while leaving internal composition,
critique and saving available. A regression proves an observed source can be saved
at the exact provider cap without another paid read. Provider/deadline regressions:
36 passed locally before the envelope-boundary extension; final exact-head CI
is required. Desktop/mobile connected-work browser suite: 6 passed locally.
The full external browser suite on `497e62f` has reached the separate mobile
acceptance gate; final terminal status is still pending.

## End-to-end continuation: recovery procedure

At `2803c4cc14801dec1cc5aabf104986a401a437c1`, external deterministic
verification passed 538 unit tests, 6 evaluation tests and 39 browser tests,
including desktop/mobile. The separate live run returned Gemini HTTP 503 before
Qloo. A bounded retry of only the live job is underway; no full live success is
claimed.

Added a Node 24 four-store SQLite snapshot/verification/restore utility, using the
SQLite backup API and streamed checksums. It requires quiesced writes and new
output directories, preserves committed WAL state, rejects incomplete/tampered
snapshots and never overwrites existing state. Two local recovery tests and
typecheck pass. Actual hosting volume/backup configuration remains unverified.
See `docs/operations/PERSISTENCE_RECOVERY.md` for the operator contract. No private
snapshot or database is included in source or CI artifacts.

## Qloo budget correction

The resumed `2803c4c` live attempt resolved all three anchors, then discovery
returned partial with zero requests; subsequent Gemini selection returned HTTP 503. A matching deterministic failure was found in the adapter: a 110-second wall
clock deadline began at provider construction and expired during model reasoning.
It now accounts only active Qloo I/O time, retaining the request cap, cache behavior
and maximum 4-second individual request deadline. A regression advances the clock
through two 80-second model pauses and proves discovery is still allowed, then
proves the request cap and cached-only reads still hold.

Qloo discovery errors retain their error status at the registry boundary instead
of being mislabeled partial. The live verifier now retains safe step summaries,
resolved IDs, evidence provenance and saved-document counts even when initial
acceptance fails. Fake-clock model deadline regressions explicitly mock abort
signals so the old 14/15-second deadlines actually fail those tests.

Focused recovery/provider regressions: 30 passed locally; typecheck passes. The
new source still requires exact-head external CI and live acceptance.

## Verified current-main integration and artifact context

The active branch incorporates main `c6fe5261460ead6989a70ad903ee43cb588a70e3`
through merge `7698ac36f4e8a21e374e5a29709f1accffb55054`, preserving the inline
conversation/work layout and engine changes. PR #27 is now mergeable and remains
draft. No release merge or deployment occurred.

Exact source `a4d2f1c5747fc5d5087079e9cdfcc3695e30e9c2` passed external run
[40929536800](https://github.com/Davemafy/qloo-test/actions/runs/40929536800):
typecheck, lint (0 errors, existing warnings), all 542 unit tests using the original
archive, 6 evaluation tests, mission-file formatting, production build and
41 browser tests (4 Codrops + 29 authenticated + 6 connected work + 2 inline work).
Repository-wide formatting debt is still reported; the full repository audit is
not a passing gate. Live acceptance was explicitly not run in that deterministic
run and its success must not be interpreted as live product acceptance.

Actual application-adapter live probe in run 40928582224 failed at the first
ordinary greeting: Gemini 3.1 Flash Lite HTTP 503 / UNAVAILABLE, one model call,
5738ms, no Qloo call. A previous run at `e6fc622` resolved all three flagship
anchors and returned 10 LIVE Qloo movie candidates before the next Gemini request
failed HTTP 503. A tiny Gemini 3.5 Flash function check returned HTTP 200, but its
actual application interpreter then returned HTTP 503. No live proposal/revision,
same-pool cultural evaluation, TrueForge execution or release-ready film is claimed.

Artifact focus now travels as optional bounded context on a real user message.
Admission verifies the reference belongs to the owner-loaded workspace, validates
the expected revision, and commits focus with the message and execution journal.
Invalid references roll back without a message or execution reservation. Context
is included in deduplication identity. Both routing and agent selection receive it.
Selecting a document alone never submits a turn, advances the server revision or
cancels active paid work. Goal-scoped local view metadata restores the selected
document on reload; the next message reads this tab's visible owned document,
not another tab's storage selection. All content, evidence and approvals remain
server-owned. New goals reset the default; explicit historical viewing does not
relax evidence-freshness acceptance.

Local focused tests: 16 passed, typecheck passed, touched-file lint 0 errors.
Full local unit execution remains blocked by the unavailable original cultural
archive (six affected suites); external CI is the authoritative full-suite path.
The new artifact-context commit still requires exact-head browser and CI results.
