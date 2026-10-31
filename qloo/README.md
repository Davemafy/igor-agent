# 🧠 Qloo inside Igor

**Qloo is not a separate recommendation screen in Igor. It's a cultural intelligence input to the agent's decisions.**

Igor starts from an ordinary user goal. When cultural discovery is useful, it retrieves relevant films, artists, places and cross-domain connections from Qloo's Taste Graph. The agent then evaluates the returned references against the user's stated preferences and the practical constraints available to it, and turns eligible choices into work that can be edited and revised.

[Try Igor](https://igor-production-243e.up.railway.app/app) · [Judge walkthrough](../README.md#judge-walkthrough) · [Source code](../src/tools/qloo-live.ts) · [Production checks](../docs/live-integration.md)

## Where Qloo ends and Igor begins

| Qloo provides | Igor handles |
| :--- | :--- |
| Cultural entity search and cross-domain associations | Interpreting the user's request and choosing the right capability |
| Entity identities, cultural results and available affinity/explanation signals | Connecting cultural references to a conversation and participant |
| Cultural evidence attached to the retrieved results | Budget, time, access, uncertainty and practical eligibility |
| Data that may be retrieved live or reused from a labeled cache | Editable documents, persistent threads and dependency-aware corrections |

**An affinity isn't a verified price, an opening time, or proof somebody will enjoy something.** Igor preserves that distinction.

## Follow the actual implementation

| Component | Source |
| :--- | :--- |
| Qloo provider calls and limits | [`src/tools/qloo-live.ts`](../src/tools/qloo-live.ts) |
| Response validation and normalized cultural results | [`src/tools/qloo-response.ts`](../src/tools/qloo-response.ts) |
| Memory/SQLite response caching | [`src/tools/qloo-cache.ts`](../src/tools/qloo-cache.ts) |
| Provider boundary | [`src/tools/interfaces.ts`](../src/tools/interfaces.ts) |
| Task interpretation and execution | [`src/core/orchestrator.ts`](../src/core/orchestrator.ts) |
| Evidence, constraints and revision contracts | [`docs/architecture.md`](../docs/architecture.md) |

## Read the evidence, not just the pitch

* [**WORKFLOW.md**](WORKFLOW.md): How a turn uses Qloo, evidence and revisions.
* [**EVIDENCE.md**](EVIDENCE.md): Dated production checks and what they establish.
* [**EVALUATION.md**](EVALUATION.md): How to reproduce the available checks and what remains unmeasured.

The historical source data is identified as **LIVE** or **CACHED**, and provider results retain timestamps and limitations. Original Qloo response recordings are not redistributed in this public repository because their redistribution rights have not been established. No substitute or synthetic “live” output is supplied to fill that gap.
