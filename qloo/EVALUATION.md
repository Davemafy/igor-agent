# 🧪 Evaluating Igor and Qloo

The question we want to test isn't simply “Did Qloo return results?” It's **whether Qloo-powered cultural evidence makes the resulting decisions more useful.**

## What can be reproduced from the public code?

Use **Node.js 24+**:

```bash
git clone https://github.com/Davemafy/igor-agent.git
cd igor-agent
npm ci
npm test
npm run test:eval
npm run typecheck
npm run build
```

`npm run test:eval` exercises the blind-evaluation tooling, including validation of real run pairs and protections against invented evidence. It **does not** report a completed human evaluation or measured Qloo uplift.

The [public test configuration](../tests/vitest.config.mts) excludes Qloo recording-dependent suites from the independently runnable unit selection. `npm run verify:all` runs additional checks and may require private recorded fixtures and the browser environment. Do not interpret an unavailable recording as a passing replay.

## A fair Qloo vs. no-Qloo comparison

1. Use the same underlying model, goal, candidate opportunity and task constraints across both arms.
2. Let one arm use Qloo cultural evidence and the other use a declared non-Qloo search/tool policy.
3. Save the actual outputs, source references, model IDs, elapsed time and Qloo evidence IDs. Do not invent a missing output.
4. Blind the reviewer to product and provider labels without changing the underlying work.
5. Score relevance, discovery, actionability, trust and coherence. Report the reviewer count, disagreements, failures and limitations.

The implementation lives in [`scripts/igor-blind-eval.mjs`](../scripts/igor-blind-eval.mjs), with validation tests in [`scripts/igor-blind-eval.test.mjs`](../scripts/igor-blind-eval.test.mjs).

**Status:** The methodology and tests are in the repository. This page makes no claim of statistically significant preference improvement or completed user satisfaction measurements.

## What the evidence proves today

* Historical production logs support live and cached Qloo discovery, saved conversation context, and budget corrections that preserved the reference pool without re-querying.
* Unit and browser coverage verify particular contracts and simulated/recorded workflows under their tested inputs.
* Recommendation quality, external venue facts, human satisfaction and every current production path require separate evidence.

[Read the actual production checks](EVIDENCE.md) · [Inspect the provider](../src/tools/qloo-live.ts) · [See supported outcomes](../docs/broader-outcomes.md)
