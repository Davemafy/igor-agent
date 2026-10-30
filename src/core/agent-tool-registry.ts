import { applyWorkActions } from "./connected-work";
import { WorkActionSchema } from "./work-contracts";
import { critiqueExperience } from "./experience-critique";
import {
  evaluateCandidates,
  reevaluateSavedCandidates,
} from "../capabilities/evaluate";
import { z } from "zod";
import { consultTrueForge, trueForgeConfig } from "../tools/trueforge";
import type { Task } from "./contracts";
import type { CulturalProvider } from "../tools/interfaces";
import type { ResearchProvider, ResearchSource } from "../tools/live-research";
import type { GooglePlacesProvider } from "../tools/google-maps";
import type { BrowserbaseObserver } from "../tools/browserbase-observer";
import { publicResearchUrl } from "../tools/live-research";

export type AgentToolPermission = "read" | "internal";
export interface AgentToolOutcome {
  status: "ok" | "partial" | "blocked" | "error";
  summary: string;
  requests: number;
  sources?: ResearchSource[];
  artifactIds?: string[];
  culturalSeedIds?: string[];
}
export interface AgentToolContext {
  task: Task;
  research: ResearchProvider;
  cultural?: CulturalProvider;
  places?: Pick<GooglePlacesProvider, "search">;
  browser?: Pick<BrowserbaseObserver, "observe">;
  sources: ResearchSource[];
  runId: string;
}
export interface AgentToolDefinition {
  name: string;
  description: string;
  permission: AgentToolPermission;
  version: number;
  available: boolean;
  schema: z.ZodType;
  execute: (
    argumentsValue: unknown,
    context: AgentToolContext,
  ) => Promise<AgentToolOutcome>;
}

const normalized = (source: ResearchSource) => source.url.trim().toLowerCase();

function saveSources(
  context: AgentToolContext,
  incoming: ResearchSource[],
): number {
  const existing = new Set(context.sources.map(normalized));
  let added = 0;
  let id =
    Math.max(
      0,
      ...context.sources.map((s) =>
        Number(s.id.match(/^web-(\d+)$/)?.[1] || 0),
      ),
    ) + 1;

  for (const source of incoming) {
    const url = publicResearchUrl(source.url);

    if (
      !url ||
      existing.has(url.toLowerCase()) ||
      context.sources.length >= 12
    ) {
      continue;
    }

    const next = { ...source, id: `web-${id++}`, url };
    context.sources.push(next);
    existing.add(url.toLowerCase());
    added++;
  }

  return added;
}

const searchArguments = z.strictObject({
  query: z.string().trim().min(3).max(200),
});
const readArguments = z.strictObject({
  sourceId: z.string().trim().min(1).max(80),
});
const resolveArguments = z.strictObject({
  name: z.string().trim().min(2).max(100),
  type: z
    .enum(["movie", "tv_show", "artist", "book", "place", "person"])
    .optional(),
});
const discoverArguments = z.strictObject({
  entityId: z.string().min(1).max(120),
  targetType: z.enum(["movie", "tv_show", "artist", "place"]),
});
const localityArguments = z.strictObject({
  city: z.string().trim().min(2).max(100),
  interest: z.string().trim().min(3).max(200),
});
const documentArguments = z.strictObject({
  fulfills: z.array(z.string().max(80)).max(6).optional(),
  candidateIds: z.array(z.string()).max(12).optional(),
  title: z.string().trim().min(3).max(160),
  content: z.string().trim().min(30).max(10000),
  sourceIds: z.array(z.string()).max(12).default([]),
  evidenceIds: z.array(z.string()).max(30).optional(),
});
const reviseArguments = documentArguments.extend({
  artifactId: z.string().min(1).max(200),
});
const trueForgeArguments = z.strictObject({
  objective: z.string().trim().min(8).max(1200),
});
const empty = z.strictObject({});
const experienceArguments = z.strictObject({
  actions: z.array(WorkActionSchema).min(1).max(24),
});

/** Bounded verified capability set. No model-supplied URL or privileged write. */
export function createAgentToolRegistry(
  context: AgentToolContext,
): AgentToolDefinition[] {
  const tool = (
    name: string,
    description: string,
    schema: z.ZodType,
    permission: AgentToolPermission,
    available: boolean | (() => boolean),
    execute: (
      args: unknown,
      ctx: AgentToolContext,
    ) => Promise<AgentToolOutcome>,
  ): AgentToolDefinition => ({
    name,
    description,
    schema,
    permission,
    get available() {
      return typeof available === "function" ? available() : available;
    },
    version: 1,
    execute,
  });

  // The harness is opt-in. It adds a delegated research/planning capability,
  // not a second Qloo source or a replacement for Igor's approved artifacts.
  const trueforge = trueForgeConfig();
  // Do not spend scarce model steps on actions the current workspace cannot
  // perform. The executor still validates permissions and protected edits.
  const revisableDocument = () =>
    context.task.artifacts.some(
      (artifact) =>
        artifact.id.startsWith("agent-doc-") &&
        !artifact.edited &&
        !artifact.locked,
    );
  const priorWork = () =>
    context.task.artifacts.length > 0 ||
    (context.task.agentRunHistory?.length ?? 0) > 0;
  const experienceRequired = () =>
    (context.task.agentRun?.requirements?.experienceDomains?.length ?? 0) > 0 ||
    (context.task.work?.decisions.length ?? 0) > 0 ||
    (context.task.work?.documents.length ?? 0) > 0;

  return [
    tool(
      "trueforge.consult",
      "Delegate a bounded independent analysis to a persistent TrueForge session. Output is UNVERIFIED working context, never Qloo evidence, a booking, or a saved artifact. Use only when an independent second analysis helps.",
      trueForgeArguments,
      "read",
      Boolean(trueforge),
      async (args, ctx) => {
        if (!trueforge) {
          return {
            status: "blocked",
            requests: 0,
            summary: "TrueForge is not configured.",
          };
        }

        const { objective } = trueForgeArguments.parse(args);
        const result = await consultTrueForge(
          trueforge,
          objective,
          ctx.task.trueforgeSessionId,
        );
        // The enclosing agent checkpoints this only on successful outcomes.
        ctx.task.trueforgeSessionId = result.sessionId;

        return {
          status: "ok",
          requests: result.requests,
          summary:
            "UNVERIFIED TrueForge analysis (not source evidence): " +
            result.text,
        };
      },
    ),
    tool(
      "web.search",
      "Search current public webpages; use a targeted query with explicit location when relevant.",
      searchArguments,
      "read",
      context.research.available !== false,
      async (args, ctx) => {
        const { query } = searchArguments.parse(args);
        const result = ctx.research.searchOnce
          ? await ctx.research.searchOnce(query)
          : await ctx.research.research(query);
        const added = saveSources(ctx, result.sources);

        return {
          status:
            result.status === "blocked"
              ? "blocked"
              : result.status === "error"
                ? "error"
                : added
                  ? "ok"
                  : "partial",
          requests: result.requests,
          summary:
            `Web search returned ${result.sources.length} leads, ${added} new unique sources. ${result.warning ?? ""}`.trim(),
          sources: added > 0 ? ctx.sources.slice(-added) : [],
        };
      },
    ),
    tool(
      "web.read",
      "Read the actual page behind a previously observed web source ID; requires a page reader.",
      readArguments,
      "read",
      Boolean(context.research.readSource) &&
        context.research.pageReadAvailable !== false,
      async (args, ctx) => {
        const { sourceId } = readArguments.parse(args);
        const source = ctx.sources.find((s) => s.id === sourceId);

        if (!source || source.excerpt || !ctx.research.readSource) {
          return {
            status: "blocked",
            summary: "Unknown, already opened or unavailable source.",
            requests: 0,
          };
        }

        const result = await ctx.research.readSource(source.url);

        if (result.status === "ok" && result.excerpt) {
          source.excerpt = result.excerpt.slice(0, 6000);
        }

        return {
          status: result.status,
          summary: source.excerpt
            ? `Opened ${source.title}. Actual excerpt: ${source.excerpt.slice(0, 1000)}`
            : (result.warning ?? "Page could not be opened."),
          requests: result.requests,
        };
      },
    ),
    tool(
      "browser.observe",
      "Inspect a real rendered public webpage, identified by an already observed source ID. Read-only, isolated Browserbase session.",
      readArguments,
      "read",
      Boolean(context.browser),
      async (args, ctx) => {
        const { sourceId } = readArguments.parse(args);
        const source = ctx.sources.find((s) => s.id === sourceId);

        if (!source || source.excerpt || !ctx.browser) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Unknown or already opened source. Browser navigation is limited to observed sources.",
          };
        }

        const result = await ctx.browser.observe(source.url);

        if (result.status === "ok") {
          source.excerpt = result.excerpt;

          return {
            status: "ok",
            requests: result.requests,
            summary: `Browserbase observed ${result.title}: ${result.excerpt.slice(0, 900)}`,
          };
        }

        return {
          status: result.status,
          requests: result.requests,
          summary: result.warning,
        };
      },
    ),
    tool(
      "places.search",
      "Resolve real place names, addresses, coordinates and Google Maps URLs.",
      searchArguments,
      "read",
      Boolean(context.places),
      async (args, ctx) => {
        const { query } = searchArguments.parse(args);

        if (!ctx.places) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Places not configured.",
          };
        }

        const result = await ctx.places.search(query);

        if (result.status !== "ok") {
          return {
            status: result.status,
            requests: result.requests,
            summary: result.warning,
          };
        }

        const now = new Date().toISOString();
        const added = saveSources(
          ctx,
          result.places.flatMap((p): ResearchSource[] =>
            p.url && publicResearchUrl(p.url)
              ? [
                  {
                    id: "web-placeholder",
                    title: p.name,
                    url: p.url,
                    snippet: `Google Places (New): ${p.name}; address ${p.address}; coordinates ${p.latitude ?? "unknown"}, ${p.longitude ?? "unknown"}. No hours, pricing or availability verified.`,
                    retrievedAt: now,
                  },
                ]
              : [],
          ),
        );

        return {
          status: result.places.length ? "ok" : "partial",
          requests: result.requests,
          summary: `Google Places returned ${result.places.length} places; ${added} sourced map links.`,
          sources: added > 0 ? ctx.sources.slice(-added) : [],
        };
      },
    ),
    tool(
      "qloo.resolve_entity",
      "Resolve a specific user-mentioned cultural reference with Qloo: {name,type?}. type may be movie, tv_show, artist, book, place or person (filmmakers/authors). Do not substitute a work for a named person or guess identifiers.",
      resolveArguments,
      "read",
      Boolean(context.cultural),
      async (args, ctx) => {
        const { name, type } = resolveArguments.parse(args);

        // This tool resolves user-provided taste anchors, not arbitrary strings
        // invented by the model (including tool identifiers like qloo.resolve_entity).
        const supplied = [
          ctx.task.agentRun?.goal ?? "",
          ...ctx.task.messages
            .filter((message) => message.role === "user")
            .map((message) => message.text),
        ]
          .join(" ")
          .toLocaleLowerCase();
        const previouslyKnown = ctx.task.entities.some(
          (entity) =>
            entity.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );

        if (
          !supplied.includes(name.trim().toLocaleLowerCase()) &&
          !previouslyKnown
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Resolve a specific cultural name already supplied in the conversation. No external Qloo request was made.",
          };
        }

        if (!ctx.cultural) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Qloo unavailable.",
          };
        }

        const result = await ctx.cultural.resolve(name, type);
        const entity = result.data;

        if (
          entity.status === "resolved" &&
          !ctx.task.entities.some((e) => e.id === entity.id)
        ) {
          ctx.task.entities.push(entity);
        }

        return {
          status: result.status === "ok" ? "ok" : "partial",
          requests: result.requestCount,
          summary:
            entity.status === "resolved"
              ? `Qloo resolved ${entity.name} as ${entity.type}: ${entity.providerId}; this identifies an entity, not a preference score.`
              : `Qloo identity ${name} is ${entity.status}; do not invent a match. ${result.warnings.join(" ")}`,
        };
      },
    ),
    tool(
      "qloo.discover",
      "Retrieve actual Qloo affinities: {entityId,targetType}. Prefer the exact id from knownEntities; an exact saved provider ID or unique saved entity name is also accepted. NEVER invent an entity. targetType is movie, tv_show, artist or place. Resolving identity alone is NOT discovery. Discover each required seed before cultural decisions.",
      discoverArguments,
      "read",
      Boolean(context.cultural),
      async (args, ctx) => {
        const { entityId, targetType } = discoverArguments.parse(args);
        const known = ctx.task.entities.filter(
          (e) => e.status === "resolved" && e.providerId,
        );
        const key = entityId.trim().toLocaleLowerCase();
        // The model may copy a source-returned provider ID or name rather than
        // Igor's internal ID. Resolve only against previously confirmed task
        // entities; ambiguous names and invented references still fail closed.
        const matches = (selector: (e: (typeof known)[number]) => string) =>
          known.filter((e) => selector(e).toLocaleLowerCase() === key);
        const candidates =
          matches((e) => e.id).length > 0
            ? matches((e) => e.id)
            : matches((e) => e.providerId!).length > 0
              ? matches((e) => e.providerId!)
              : matches((e) => e.name);
        const entity = candidates.length === 1 ? candidates[0] : undefined;

        if (!entity || !ctx.cultural) {
          return {
            status: "blocked",
            requests: 0,
            summary: "No resolved Qloo seed in this task.",
          };
        }

        const result = await ctx.cultural.discover({
          anchor: {
            providerId: entity.providerId!,
            name: entity.name,
            type: entity.type,
          },
          targetTypes: [targetType],
          participants: ctx.task.brief.participants,
          entities: ctx.task.entities,
          catalogue: [],
          location: ctx.task.brief.constraints.location,
          version: ctx.task.brief.version,
          mode: ctx.task.mode,
        });

        const protectedIds = new Set([
          ...ctx.task.brief.selected,
          ...(ctx.task.brief.pinned ?? []),
          ...(ctx.task.canvas?.comparisonIds ?? []),
          ...ctx.task.artifacts
            .filter((a) => a.locked || a.edited)
            .flatMap((a) => a.candidateIds ?? []),
          ...result.data.options.map((c) => c.id),
        ]);
        const activeReferences = ctx.task.agentRun?.requirements
          ?.culturalReferences ?? [entity.name];
        const activeSeeds = new Set(
          ctx.task.entities
            .filter((e) =>
              activeReferences.some(
                (name) =>
                  name.toLocaleLowerCase() === e.name.toLocaleLowerCase(),
              ),
            )
            .map((e) => e.providerId)
            .filter(Boolean),
        );
        const observed = [];

        for (const candidate of result.data.options) {
          const scoped = {
            ...candidate,
            cultural: Object.fromEntries(
              Object.entries(candidate.cultural ?? {}).map(([key, signal]) => [
                key === "context" && signal.signalScope === "context"
                  ? `context:${signal.queryId}`
                  : key,
                signal,
              ]),
            ),
          };
          const existing = ctx.task.catalogue.find(
            (c) => c.id === candidate.id,
          );

          if (existing) {
            existing.cultural = { ...existing.cultural, ...scoped.cultural };
            observed.push(existing);
            continue;
          }

          if (ctx.task.catalogue.length >= 30) {
            const retired = ctx.task.catalogue.findIndex(
              (c) =>
                !protectedIds.has(c.id) &&
                !Object.values(c.cultural ?? {}).some((signal) =>
                  signal.seedIds.some((seed) => activeSeeds.has(seed)),
                ),
            );

            if (retired >= 0) {
              const [old] = ctx.task.catalogue.splice(retired, 1);
              const historical = ctx.task.candidates.find(
                (c) => c.id === old.id,
              );

              if (historical) {
                historical.freshness = "stale";
              }
            }
          }

          if (ctx.task.catalogue.length < 30) {
            ctx.task.catalogue.push(scoped);
            observed.push(scoped);
          }
        }

        const evidenceIds = new Set(ctx.task.evidence.map((e) => e.id));

        for (const evidence of result.data.evidence) {
          if (!evidenceIds.has(evidence.id)) {
            ctx.task.evidence.push(evidence);
          }
        }

        for (const candidate of evaluateCandidates(observed, ctx.task)) {
          const index = ctx.task.candidates.findIndex(
            (c) => c.id === candidate.id,
          );

          if (index < 0) {
            ctx.task.candidates.push(candidate);
          } else {
            ctx.task.candidates[index] = candidate;
          }
        }

        return {
          status:
            result.status === "ok"
              ? "ok"
              : result.status === "blocked"
                ? "blocked"
                : result.status === "error"
                  ? "error"
                  : "partial",
          requests: result.requestCount,
          culturalSeedIds: [entity.providerId!],
          summary:
            `Qloo ${targetType} discovery returned ${result.data.options.length} actual candidates (${observed.length} retained in the active catalogue): ${result.data.options
              .slice(0, 5)
              .map((x) => x.name)
              .join(", ")}. ${result.warnings.join(" ")}`.slice(0, 580),
        };
      },
    ),
    tool(
      "qloo.explore_location",
      "Retrieve Qloo restaurant-category leads for a user-supplied city, not verified openings or personal affinities.",
      localityArguments,
      "read",
      Boolean(context.cultural?.exploreLocality),
      async (args, ctx) => {
        const { city, interest } = localityArguments.parse(args);

        if (!ctx.cultural?.exploreLocality) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Qloo local exploration unavailable.",
          };
        }

        const result = await ctx.cultural.exploreLocality(city, interest);
        const seen = new Set(ctx.task.evidence.map((e) => e.id));

        for (const evidence of result.data.evidence) {
          if (!seen.has(evidence.id)) {
            ctx.task.evidence.push(evidence);
          }
        }

        const now = new Date().toISOString();
        saveSources(
          ctx,
          result.data.places.flatMap((p): ResearchSource[] =>
            p.website && publicResearchUrl(p.website)
              ? [
                  {
                    id: "web-placeholder",
                    title: p.name,
                    url: p.website,
                    snippet: `Qloo locality/category lead: ${p.name}; ${p.address}. Prices, game inventory and availability are not verified.`,
                    retrievedAt: now,
                  },
                ]
              : [],
          ),
        );

        return {
          status:
            result.status === "blocked"
              ? "blocked"
              : result.status === "error"
                ? "error"
                : result.status === "ok"
                  ? "ok"
                  : "partial",
          requests: result.requestCount,
          summary:
            `Qloo returned ${result.data.places.length} category/location leads: ${result.data.places
              .slice(0, 5)
              .map((p) => p.name)
              .join(
                ", ",
              )}. This is not verified personal affinity. ${result.warnings.join(" ")}`.slice(
              0,
              580,
            ),
        };
      },
    ),
    tool(
      "task.inspect",
      "Read current saved goal, relevant artifacts and prior evidence without modifying work.",
      empty,
      "read",
      priorWork,
      async (_args, ctx) => ({
        status: "ok",
        requests: 0,
        summary: JSON.stringify({
          goal: ctx.task.brief.goal.slice(0, 140),
          artifacts: ctx.task.artifacts.slice(-3).map((a) => ({
            id: a.id,
            title: a.title,
            edited: a.edited,
            locked: a.locked,
          })),
          evidence: ctx.task.evidence.length,
        }).slice(0, 580),
      }),
    ),
    tool(
      "experience.compose",
      "Compose or selectively revise linked experience work in the existing task. Supply actions for goal, typed decisions (domain, rationaleKind, candidateIds, evidenceIds, dependencies, alternatives, estimatedCost or null), documents (fulfills and candidateIds), grounded budget/reduce-budget or alcohol-free restriction. Connect food/atmosphere/space to audience/music decisions. Never approve, reject, edit protected work or execute external actions. Independent critique runs automatically. Reuse current Qloo observations for budget-only changes.",
      experienceArguments,
      "internal",
      experienceRequired,
      async (args, ctx) => {
        const { actions } = experienceArguments.parse(args);

        if (
          actions.some((action) =>
            ["approve", "reject", "edit", "external"].includes(action.kind),
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Only the user can approve or replace protected work. No action executed.",
          };
        }

        const userText =
          ctx.task.messages.filter((m) => m.role === "user").at(-1)?.text ??
          ctx.task.agentRun?.goal ??
          "";
        const targetBudget = ctx.task.agentRun?.requirements?.budget?.amount;

        if (
          targetBudget !== undefined &&
          ctx.task.work?.budget?.amount === targetBudget &&
          actions.some(
            (action) => action.kind === "reduce-budget" && action.percent > 0,
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary: `This run already confirmed budget ${targetBudget}. Omit the repeated reduction and revise only affected decisions.`,
          };
        }

        const summary = applyWorkActions(ctx.task, actions, userText);
        // Re-evaluate existing observations against revised practical constraints,
        // without another paid retrieval or resurrecting invalidated Qloo evidence.
        reevaluateSavedCandidates(ctx.task);
        const critique = critiqueExperience(ctx.task);
        ctx.task.work!.critique = critique;

        return {
          status: critique.issues.some((i) => i.severity === "error")
            ? "partial"
            : "ok",
          requests: 0,
          summary: (
            summary +
            " Issues: " +
            JSON.stringify(critique.issues)
          ).slice(0, 1800),
          artifactIds: actions
            .filter((a) => a.kind === "document")
            .map((a) => `document:${a.id}`),
        };
      },
    ),
    tool(
      "experience.critique",
      "Independently check saved experience decisions for budget/schedule/source contradictions, incoherence and unresolved practical facts. This reads saved state; it is not an external fact check.",
      empty,
      "internal",
      true,
      async (_args, ctx) => {
        const critique = critiqueExperience(ctx.task);

        if (ctx.task.work) {
          ctx.task.work.critique = critique;
        }

        return {
          status: critique.issues.some((i) => i.severity === "error")
            ? "partial"
            : "ok",
          requests: 0,
          summary: JSON.stringify(critique).slice(0, 2400),
        };
      },
    ),
    tool(
      "document.create",
      "Create editable work: {title, content, sourceIds, evidenceIds?}. Use observed web sourceIds and current Qloo evidenceIds. Never overwrite approved or manually edited work.",
      documentArguments,
      "internal",
      true,
      async (args, ctx) => {
        const {
          title,
          content,
          sourceIds,
          evidenceIds: culturalIds = [],
          fulfills,
          candidateIds,
        } = documentArguments.parse(args);

        if (
          candidateIds?.some(
            (id) => !ctx.task.catalogue.some((c) => c.id === id),
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Document selected an unobserved cultural candidate. Seed IDs are not candidate IDs. Call qloo.discover to observe actual choices first; never invent candidateIds.",
          };
        }

        // Models may echo a server-owned evidence ID or a retrieved URL
        // instead of the short web source ID. Accept only exact references
        // to sources observed in THIS run; never resolve guessed citations.
        const sourceReferences = sourceIds.map((reference) => {
          const observed = ctx.sources.find((source) => {
            const evidenceId = `${ctx.task.id}:agent:${ctx.runId}:${source.id}`;

            return [source.id, source.url, evidenceId].includes(reference);
          });

          return observed?.id;
        });

        if (sourceReferences.some((id) => !id)) {
          const allowed = ctx.sources
            .map((source) => source.id)
            .slice(-12)
            .join(", ");

          return {
            status: "blocked",
            requests: 0,
            summary: `Document cited an unobserved source. Valid sourceIds: ${allowed || "none"}. Use exact observed IDs, not titles or invented numbers.`,
          };
        }

        const groundedSourceIds = [
          ...new Set(sourceReferences.filter((id): id is string => !!id)),
        ];

        if (
          culturalIds.some(
            (id) =>
              !ctx.task.evidence.some(
                (e) => e.id === id && e.freshness === "current",
              ),
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Document cited missing or stale evidence.",
          };
        }

        const evidenceIds = [
          ...culturalIds,
          ...groundedSourceIds.map(
            (id) => `${ctx.task.id}:agent:${ctx.runId}:${id}`,
          ),
        ];
        const count = ctx.task.artifacts.filter((artifact) =>
          artifact.id.startsWith(`agent-doc-${ctx.runId}-`),
        ).length;

        if (count >= 3) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Per-run document limit reached.",
          };
        }

        ctx.task.artifacts.push({
          id: `agent-doc-${ctx.runId}-${count + 1}`,
          kind: "research-report",
          fulfills,
          candidateIds,
          title,
          content,
          version: ctx.task.brief.version,
          dependencies: ["evidence:research"],
          evidenceIds,
          assumptions: [
            "This document distinguishes confirmed source observations from remaining uncertainties.",
          ],
          freshness: "current",
          edited: false,
        });

        return {
          status: "ok",
          requests: 0,
          summary: `Saved editable document ${title} with ${groundedSourceIds.length} observed source IDs.`,
          artifactIds: [`agent-doc-${ctx.runId}-${count + 1}`],
        };
      },
    ),
    tool(
      "document.revise",
      "Revise an agent-created document by artifactId. Arguments: {artifactId,title,content,sourceIds,evidenceIds?}. Locked or manually edited work is protected.",
      reviseArguments,
      "internal",
      revisableDocument,
      async (args, ctx) => {
        const {
          artifactId,
          title,
          content,
          sourceIds,
          evidenceIds = [],
          fulfills,
          candidateIds,
        } = reviseArguments.parse(args);

        if (
          candidateIds?.some(
            (id) => !ctx.task.catalogue.some((c) => c.id === id),
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary: "Revision selected an unobserved cultural candidate.",
          };
        }

        const artifact = ctx.task.artifacts.find((a) => a.id === artifactId);

        if (
          !artifact ||
          !artifact.id.startsWith("agent-doc-") ||
          artifact.edited ||
          artifact.locked
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Document is missing, manually edited, approved or not agent-created. Preserve it.",
          };
        }

        // A follow-up may cite the current run's web IDs or evidence already
        // attached to this exact artifact. Historical citations are not new
        // sources; reuse only their existing, current and persisted evidence.
        const trusted = [
          ...ctx.sources.map((source) => ({
            id: `${ctx.task.id}:agent:${ctx.runId}:${source.id}`,
            aliases: [
              source.id,
              source.url,
              `${ctx.task.id}:agent:${ctx.runId}:${source.id}`,
            ],
          })),
          ...ctx.task.evidence
            .filter(
              (e) =>
                artifact.evidenceIds.includes(e.id) &&
                e.kind === "practical" &&
                e.freshness === "current",
            )
            .map((e) => ({
              id: e.id,
              aliases: [e.id, e.reference, e.id.split(":").at(-1) ?? ""],
            })),
        ];
        const sourceEvidence = sourceIds.map((reference) => {
          const matches = new Set(
            trusted
              .filter((entry) => entry.aliases.includes(reference))
              .map((entry) => entry.id),
          );

          return matches.size === 1 ? [...matches][0] : null;
        });

        if (
          sourceEvidence.some((id) => !id) ||
          evidenceIds.some(
            (id) =>
              !ctx.task.evidence.some(
                (e) => e.id === id && e.freshness === "current",
              ),
          )
        ) {
          return {
            status: "blocked",
            requests: 0,
            summary:
              "Revision cited unobserved evidence. Reuse the saved artifact's existing evidence IDs or this run's observed source IDs.",
          };
        }

        artifact.fulfills = fulfills ?? artifact.fulfills;
        artifact.candidateIds = candidateIds ?? artifact.candidateIds;
        artifact.title = title;
        artifact.content = content;
        artifact.version = ctx.task.brief.version;
        artifact.evidenceIds = [
          ...new Set([
            ...artifact.evidenceIds,
            ...evidenceIds,
            ...sourceEvidence.filter((id): id is string => Boolean(id)),
          ]),
        ];
        artifact.freshness = "current";

        return {
          status: "ok",
          requests: 0,
          summary: `Revised saved document ${artifact.id}; identity preserved.`,
          artifactIds: [artifact.id],
        };
      },
    ),
    tool(
      "agent.finish",
      "Stop when the available evidence suffices or remaining actions would not help.",
      empty,
      "read",
      true,
      async () => ({
        status: "ok",
        requests: 0,
        summary: "Agent stopped further tool calls.",
      }),
    ),
  ];
}
