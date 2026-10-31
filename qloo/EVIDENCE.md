# 🔗 Qloo evidence and observed behavior

The following checks were documented on **October 26, 2026** against the Railway application using its configured model and Qloo adapters. This page gives judges a short route into the original records. It is not a new execution report for the current submission commit.

## Observed production journeys

| Request / step | Observed outcome | What it demonstrates |
| :--- | :--- | :--- |
| “I like Portishead and Arrival. Find films for me for a quiet evening.” | Ten film references; **LIVE** Qloo evidence; two Qloo requests and one model request | Cultural discovery with a configured Qloo provider |
| “I like Radiohead and Arrival. Find films for me for a quiet evening.” | Ten film references; **CACHED** Qloo evidence and one model request | Reuse of previously obtained cultural evidence, not a fresh call |
| “Budget: 20” after the two discovery requests | Budget updated, reference pool retained, **zero** Qloo requests in each correction | A practical change needn't repeat cultural discovery |
| Seven-turn discussion including an anniversary and a quiet mood | Earlier occasion and mood recalled; fourteen discussion messages restored by task API | Conversation continuity in that test |

Sources: [Railway integration notes](../docs/live-integration.md) and [recorded verification metadata](../docs/verification.json). The production notes also record a separate structured discovery returning thirty film/TV/artist references with three live Qloo requests.

## What's actually attributable to Qloo?

The Qloo evidence supports cultural discovery and cross-domain associations. Igor then applies context, attribution, constraints and composition. Neither the recorded Qloo calls nor a completed HTTP request prove that recommendations improve human satisfaction, venue feasibility or booking success.

## Provider-contract checks

A separate [public Qloo test repository](https://github.com/Davemafy/qloo-test) has independent GitHub Actions evidence:

* [Offline provider regressions](https://github.com/Davemafy/qloo-test/actions/runs/40167634005): twelve script contracts and eight response-summary checks passed.
* [Fresh place discovery](https://github.com/Davemafy/qloo-test/actions/runs/40167409602): four Qloo requests completed; no model calls.
* [Gemini correction checks](https://github.com/Davemafy/qloo-test/actions/runs/40167409632): three cases passed and one failed because an access confirmation was omitted.

These are provider-contract checks, **not** the current public Next.js application's full acceptance test.

## Public repository boundary

The original compressed Qloo responses were removed from the public history because redistribution rights are unresolved. Recording-dependent replay tests need those authorized private fixtures, and must not be described as passed from a sanitized checkout.

A judge can inspect the [source integration](../src/tools/qloo-live.ts), the [production verification narrative](../docs/live-integration.md), and [the reported results](../docs/verification.json). A fresh live result requires an authorized Qloo key configured server-side and must be evaluated on the actual runtime, not inferred from the historical report.
