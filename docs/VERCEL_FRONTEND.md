# Deploy Igor's interface on Vercel, independently of its engine

**Topology:** Browser → Vercel Next.js frontend (same-origin `/api/*` rewrite) → an HTTPS Igor backend on Railway or any other persistent host.

The visual interface and its 12 views do **not** need a hard-coded Railway URL. Switching engine hosts only changes the Vercel project environment variable; no React code changes or new browser cookies are required. The browser continues to receive server-owned Task, Event, Evidence, Document and revision state using the existing typed Igor contracts.

## Required deployment configuration

Deploy the `integration/igor-engine-ui-release-20261031` branch as a **Next.js** project, with **repository root** as the root directory and **Node.js 24.x**. Do not configure a second web backend or fake local SQLite storage on Vercel.

In the **Vercel project** environment variables (Production, and each Preview environment as appropriate):

```dotenv
IGOR_FRONTEND_ONLY=1
IGOR_BACKEND_ORIGIN=https://your-persistent-igor-engine.example
```

The backend origin is a **server-side build/runtime configuration**, not a `NEXT_PUBLIC_*` browser variable. It must be HTTPS with no path, query, credentials or trailing routes. Next.js before-file rewrites forward **every** `/api/*` request, including long-running SSE turns, turn journals, saved outputs, account sessions and reviews, to `IGOR_BACKEND_ORIGIN/api/*`. The marketing homepage and all visual routes remain local to Vercel.

On Vercel, absence of `IGOR_BACKEND_ORIGIN` is a **build error by design**. Do not silently fall back to the repository's embedded API handlers: they rely on durable backend state and must not run as ephemeral Vercel functions. The repository still contains engine source for integration testing; this is a traffic-level frontend/backend split, **not yet a separate frontend-only code package**.

In the **backend** environment (Railway or another persistent server), configure the origin(s) that are allowed to submit writes through the Vercel proxy:

```dotenv
IGOR_ALLOWED_FRONTEND_ORIGINS=https://your-igor-app.vercel.app,https://app.yourdomain.example
```

Use **exact** HTTPS origins, separated by commas. Add each preview deployment's exact URL if it needs to send writes. Do **not** allow `*.vercel.app`, use `*`, or disable CSRF validation. The engine still rejects `Sec-Fetch-Site: cross-site`. Local development may use an HTTP loopback origin.

The backend must be deployed with the updated origin-policy code and a **persistent** auth, task and outcomes store. These environment variables control routing, **not** model availability; configure Qloo, Gemini/Grok, web search and provider budgets on the backend only. Never add provider secrets to the Vercel project.

## What stays backend-owned

- User sessions and HTTP-only `igor_session` cookie. Responses travel through Vercel's same-origin proxy; do not attempt third-party cookie authentication directly from browser JavaScript.
- Message admission, stable `clientTurnId`, server-led execution and streaming SSE events.
- Version conflicts (409), persisted event journal, reconnect/reload, revision history and artifact edits.
- Evidence/provenance, Qloo calls, model calls, provider keys, email/approval-controlled actions and SQLite/database state.

No new state store or frontend-specific agent logic is introduced. `src/components/workspace-api.ts` remains the typed, same-origin transport boundary. UI rendering consumes `TaskSchema` and `EventSchema`; it does not choose providers.

## Release smoke test on the actual Vercel Preview URL

1. Open `https://<your-preview>/api/health`. You should see the **backend's** status and revision, not a separate Vercel function revision. A 404/500 here means proxy, backend readiness or environment configuration is wrong.
2. In a clean browser, open `/app`, create a workspace, and confirm `POST /api/tasks` returns an HTTP-only `igor_session` cookie scoped to your **frontend host**. The UI must retrieve the same workspace on refresh.
3. Send a real request and watch `POST /api/tasks/:id/turn` stream SSE. Confirm that heartbeats/progress arrive without buffering, that `X-Igor-Turn-Id` is present, and that a refresh retrieves the saved turn through `GET /api/tasks/:id/turn?turnId=...&after=...`.
4. Save an editable artifact; revise it while preserving unrelated decisions, then verify the same version/IDs after refresh.
5. Sign in/out and ensure account state and saved outputs are served by the engine. Test a 409 edit conflict and an interrupted stream without resubmitting the paid turn.
6. Test a source-backed non-cultural research goal and a genuine Qloo experience goal. Treat incomplete or unverified external/provider work as **blocked**, not success.
7. Run `curl -i https://<your-preview>/api/health` and verify the response is not a cached/static Vercel result. Repeat after switching Vercel's `IGOR_BACKEND_ORIGIN` in a new deployment.

**Deployment caveat:** Vercel rewrites can proxy externally, but buffering, stream timeouts, cookie forwarding and CSRF checks must be exercised on a **real Preview deployment**. Local build/unit tests cannot prove that the production proxy preserves multi-minute SSE streams. If the proxy proves unsuitable, keep the same typed frontend API interface and use a streaming-capable gateway on the same public origin; don't move agent execution into Vercel functions.

## Local development modes

- **Existing integrated mode:** leave `IGOR_FRONTEND_ONLY` and `IGOR_BACKEND_ORIGIN` unset; `npm run dev` serves its local backend.
- **Proxy mode:** start the engine separately, then run the UI with `IGOR_FRONTEND_ONLY=1 IGOR_BACKEND_ORIGIN=http://127.0.0.1:3570` outside Vercel. Add the frontend's `http://127.0.0.1:<port>` to the backend's trusted-origin list.

This changes deployment topology, not the visuals or agent implementation.
