import {
  AgentAcceptanceSchema,
  AgentRequirementsSchema,
} from "./agent-acceptance";
import { z } from "zod";
import {
  PresentationSchema,
  CanvasStateSchema,
  CanvasMutationSchema,
} from "./presentation";
import { OutcomeSpecSchema, OutcomeDetailsSchema } from "./outcome-spec";
import { WorkStateSchema, WorkActionSchema } from "./work-contracts";
import { AgentActivitySchema } from "./agent-events";

export const Source = z.enum([
  "user-supplied",
  "verified-external",
  "provider-returned",
  "recorded-fixture",
  "illustrative-example",
]);

export const EntityType = z.enum([
  "movie",
  "tv_show",
  "artist",
  "book",
  "place",
  "person",
]);

export const PreferenceSchema = z.object({
  entityType: EntityType.optional(),
  id: z.string(),
  subject: z.string(),
  value: z.string().min(1).max(100),
  polarity: z.enum(["like", "dislike", "unknown", "not-now"]),
  source: Source,
  confirmed: z.boolean(),
  scope: z.enum(["participant", "task", "persistent"]),
});

export const ParticipantSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  preferences: z.array(PreferenceSchema).max(20),
  sample: z.boolean(),
});

export const EntitySchema = z
  .object({
    id: z.string(),
    original: z.string(),
    name: z.string(),
    type: EntityType,
    providerId: z.string().nullable(),
    status: z.enum(["resolved", "ambiguous", "unresolved"]),
    metadata: z.string(),
    choices: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: EntityType,
          metadata: z.string().max(500).optional(),
        }),
      )
      .default([]),
  })
  .superRefine((entity, ctx) => {
    if ((entity.status === "resolved") !== Boolean(entity.providerId)) {
      ctx.addIssue({
        code: "custom",
        message: "Only resolved entities may carry a confirmed provider ID.",
      });
    }

    if (entity.status === "ambiguous" && entity.choices.length < 2) {
      ctx.addIssue({
        code: "custom",
        message: "Ambiguous resolution requires alternative identities.",
      });
    }
  });

export const FactSchema = z.object({
  value: z.number().nonnegative().nullable(),
  source: Source,
  reference: z.string().max(300),
  at: z.string(),
});

export const CandidateInputSchema = z.object({
  imageUrl: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);

      return u.protocol === "https:" && u.hostname === "images.qloo.com";
    })
    .nullable()
    .optional(),
  place: z
    .object({
      latitude: z.number().min(-90).max(90).nullable(),
      longitude: z.number().min(-180).max(180).nullable(),
      address: z.string().max(500),
      website: z
        .string()
        .url()
        .refine((v) => /^https?:\/\//.test(v))
        .nullable(),
      locality: z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          disambiguation: z.string(),
        })
        .nullable(),
    })
    .optional(),
  cultural: z
    .record(
      z.string(),
      z.object({
        signalScope: z.enum(["participant", "context"]).optional(),
        affinity: z.number().finite().nullable(),
        rank: z.number().int().positive(),
        queryId: z.string(),
        seedIds: z.array(z.string()),
        explanationScope: z
          .enum(["recommendation", "aggregate-query", "none"])
          .optional(),
        explanationEntities: z.array(
          z.object({
            entity_id: z.string(),
            avg_score: z.number().finite().optional(),
            score: z.number().finite().optional(),
          }),
        ),
        delivery: z.enum(["LIVE", "CACHED"]),
        retrievedAt: z.string(),
      }),
    )
    .optional(),
  providerId: z.string().min(1).nullable().default(null),
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  type: EntityType,
  tags: z.array(z.string().min(1).max(60)).max(15),
  description: z.string().max(500),
  cost: FactSchema,
  duration: FactSchema,
  available: z.boolean().nullable(),
  availabilitySource: Source,
  location: z.string().max(100).nullable(),
  sample: z.boolean(),
});

export const CandidateSchema = CandidateInputSchema.extend({
  eligibility: z.enum(["eligible", "ineligible", "needs-review"]),
  dependencies: z.array(z.string()),
  freshness: z.enum(["current", "stale"]).default("current"),
  missing: z.array(z.string()),
  violations: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  fit: z.record(z.string(), z.number()),
  fitReason: z.string(),
});

export const EvidenceSchema = z.object({
  delivery: z.enum(["LIVE", "CACHED"]).optional(),
  kind: z.enum(["cultural", "practical", "supplied"]).optional(),
  id: z.string(),
  source: Source,
  at: z.string(),
  reference: z.string(),
  // Optional verified research metadata for visual source cards.
  title: z.string().max(220).optional(),
  previewImageUrl: z.string().url().max(2048).optional(),
  entityIds: z.array(z.string()),
  summary: z.string(),
  limitations: z.array(z.string()),
  explanation: z.string().nullable(),
  dependencies: z.array(z.string()),
  freshness: z.enum(["current", "stale"]),
});

export const ArtifactSchema = z.object({
  fulfills: z.array(z.string().max(80)).max(6).optional(),
  candidateIds: z.array(z.string()).max(12).optional(),
  details: OutcomeDetailsSchema.optional(),
  id: z.string(),
  kind: z.enum([
    "programme",
    "invitation",
    "comparison",
    "creative-brief",
    "itinerary",
    "listening-plan",
    "research-report",
    "music-direction",
  ]),
  title: z.string(),
  content: z.string(),
  version: z.number().int(),
  dependencies: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  assumptions: z.array(z.string()),
  freshness: z.enum(["current", "stale"]),
  edited: z.boolean().default(false),
  locked: z.boolean().optional(),
});

export const BriefSchema = z.object({
  outcome: OutcomeSpecSchema.optional(),
  contextAnchor: z
    .object({
      providerId: z.string().uuid(),
      name: z.string(),
      type: EntityType,
    })
    .optional(),
  targetType: z.enum(["movie", "tv_show", "artist", "place"]).optional(),
  pinned: z.array(z.string()).max(3).optional(),
  goal: z.string().max(3000),
  owner: z.string(),
  participants: z.array(ParticipantSchema).max(12),
  constraints: z.object({
    budget: z.number().min(0).max(1000000),
    duration: z.number().int().min(15).max(1440),
    location: z.string().min(1).max(100),
    currency: z.literal("USD"),
  }),
  selected: z.array(z.string()),
  unresolved: z.array(z.string()),
  suppliedFacts: z.array(z.string()),
  assumptions: z.array(z.string()),
  version: z.number().int().nonnegative(),
  kind: z.enum(["gathering", "discovery", "creative"]),
});

export const TraceSchema = z.object({
  id: z.string(),
  version: z.number(),
  action: z.string(),
  requests: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  outcome: z.string(),
  evidenceIds: z.array(z.string()),
  at: z.string(),
});

export const ToolStatus = z.enum([
  "ok",
  "partial",
  "ambiguous",
  "empty",
  "blocked",
  "error",
]);

export const ToolResultSchema = z.object({
  status: ToolStatus,
  data: z.unknown(),
  evidenceIds: z.array(z.string()),
  warnings: z.array(z.string()),
  retry: z.enum(["never", "manual"]),
  requestCount: z.number().int().nonnegative(),
});

export const ScheduleSchema = z.object({
  label: z.string(),
  minutes: z.number().nonnegative(),
  candidateId: z.string().nullable(),
});

/** Durable, per-task agent ledger; evidence bodies remain bounded. */
export const AgentRunSchema = z.object({
  acceptance: AgentAcceptanceSchema.optional(),
  requirements: AgentRequirementsSchema.optional(),
  culturalSeedIds: z.array(z.string()).max(12).optional(),
  outputArtifactIds: z.array(z.string()).max(12).optional(),
  id: z.string().uuid(),
  goal: z.string().max(3000),
  status: z.enum([
    "created",
    "reasoning",
    "executing_tool",
    "observing",
    "verifying",
    "completed",
    "partially_completed",
    "interrupted",
    "failed",
    "awaiting_approval",
    "cancelled",
  ]),
  startedAt: z.string(),
  updatedAt: z.string(),
  maxSteps: z.number().int().min(1).max(12),
  maxRequests: z.number().int().min(1).max(40),
  requests: z.number().int().nonnegative(),
  modelSteps: z.number().int().nonnegative(),
  usage: z
    .object({
      modelCalls: z.number().int().nonnegative(),
      providerRequests: z.number().int().nonnegative(),
      modelTokens: z.number().int().nonnegative().nullable(),
      estimatedCostUsd: z.number().nonnegative().nullable(),
    })
    .optional(),
  steps: z
    .array(
      z.object({
        id: z.string().uuid(),
        tool: z.string().max(70),
        status: z.enum(["ok", "partial", "blocked", "error"]),
        requests: z.number().int().nonnegative(),
        summary: z.string().max(600),
        at: z.string(),
        durationMs: z.number().nonnegative(),
      }),
    )
    .max(12),
  sources: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().max(220),
        url: z.string().url().max(2048),
        snippet: z.string().max(900),
        excerpt: z.string().max(6000).optional(),
        retrievedAt: z.string(),
        imageUrl: z.string().url().max(2048).optional(),
      }),
    )
    .max(12),
  warnings: z.array(z.string().max(500)).max(20),
});

/** Compact completed/interrupted run history. Keep the latest observations in
 * agentRun; archive only provenance and counts to avoid large SQLite payloads. */
export const AgentRunHistorySchema = z.object({
  id: z.string().uuid(),
  goal: z.string().max(3000),
  status: AgentRunSchema.shape.status,
  startedAt: z.string(),
  archivedAt: z.string(),
  requests: z.number().int().nonnegative(),
  modelSteps: z.number().int().nonnegative(),
  toolNames: z.array(z.string().max(70)).max(12),
  sourceCount: z.number().int().nonnegative(),
  savedArtifactIds: z.array(z.string()).max(12),
});

export const ConversationFocusSchema = z.object({
  activeGoalId: z.string().nullable().optional(),
  openQuestions: z.array(z.string()).optional(),
  unresolvedAssumptions: z.array(z.string()).optional(),
  decisionIds: z.array(z.string()).optional(),
  confirmedPreferenceIds: z.array(z.string()).optional(),
  activeArtifactId: z.string().nullable().default(null),
  activeCandidateIds: z.array(z.string()).max(30).default([]),
  ordinalMap: z.record(z.string(), z.string()).default({}),
  lastResultRevision: z.number().int().nonnegative().default(0),
  lastQuestionId: z.string().nullable().default(null),
  pendingQuestion: z
    .object({
      prompt: z.string().min(1).max(1600),
      messageIndex: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  referencedParticipants: z.array(z.string()).max(12).default([]),
});

export const TaskSchema = z.object({
  conversationFocus: ConversationFocusSchema.optional(),
  // Optional TrueForge delegation context, owned by this single Igor task.
  trueforgeSessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,160}$/)
    .optional(),
  agentRun: AgentRunSchema.optional(),
  agentRunHistory: z.array(AgentRunHistorySchema).max(12).optional(),
  canvas: CanvasStateSchema.optional(),
  work: WorkStateSchema.optional(),
  evidenceArchive: z.array(EvidenceSchema).optional(),
  artifactHistory: z
    .array(
      z.object({
        artifact: ArtifactSchema,
        at: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  reviewEffects: z.array(z.string().uuid()).max(100).optional(),
  receipts: z
    .array(
      z.object({
        id: z.string(),
        fromVersion: z.number().int(),
        toVersion: z.number().int(),
        at: z.string(),
        inputHash: z.string(),
        changed: z.array(z.string()),
        culturalRequests: z.number().int().nonnegative(),
        modelRequests: z.number().int().nonnegative(),
        status: z.string(),
        evidenceIds: z.array(z.string()),
        artifactIds: z.array(z.string()),
        selection: z.array(z.string()),
      }),
    )
    .max(40)
    .optional(),
  modelMode: z.enum(["scripted", "tool-calling"]).optional(),
  id: z.string(),
  brief: BriefSchema,
  catalogue: z.array(CandidateInputSchema).max(30),
  candidates: z.array(CandidateSchema),
  entities: z.array(EntitySchema),
  evidence: z.array(EvidenceSchema),
  artifacts: z.array(ArtifactSchema),
  trace: z.array(TraceSchema),
  messages: z.array(
    z.object({
      id: z.string().optional(),
      role: z.enum(["user", "assistant"]),
      kind: z.literal("conversation").optional(),
      evidenceIds: z.array(z.string()).optional(),
      text: z.string(),
      at: z.string(),
    }),
  ),
  schedule: z.array(ScheduleSchema),
  status: z.enum([
    "draft",
    "running",
    "ready",
    "partial",
    "clarification",
    "error",
  ]),
  mode: z.enum(["illustrative-fixtures", "qloo-live"]),
  evaluation: z
    .object({
      version: z.number(),
      status: z.enum(["ok", "blocked", "error"]),
      baseline: z.array(z.string()),
      assisted: z.array(z.string()),
      warnings: z.array(z.string()),
      model: z.string(),
      at: z.string(),
    })
    .optional(),
  simulation: z.enum([
    "none",
    "empty",
    "timeout",
    "auth",
    "rate-limit",
    "malformed",
  ]),
  preferences: z.array(PreferenceSchema),
  error: z.string().nullable(),
});

export const ConversationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("profile"),
    participant: z.string().trim().min(1).max(60),
    preferences: z
      .array(
        z.strictObject({
          value: z.string().trim().min(1).max(100),
          polarity: z.enum(["like", "dislike", "unknown", "not-now"]),
          entityType: EntityType.optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  z.strictObject({
    kind: z.literal("constraints"),
    budget: z.number().min(0).max(1000000).optional(),
    duration: z.number().int().min(15).max(1440).optional(),
    location: z.string().trim().min(1).max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal("preference"),
    participant: z.string().min(1).max(80),
    value: z.string().min(1).max(100),
    polarity: z.enum(["like", "dislike", "unknown", "not-now"]),
    entityType: EntityType.optional(),
  }),
  z.strictObject({
    kind: z.literal("facts"),
    candidate: z.string().min(1).max(120),
    cost: z.number().nonnegative().nullable().optional(),
    duration: z.number().int().min(1).max(1440).nullable().optional(),
    available: z.boolean().nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal("resolve"),
    entity: z.string().min(1).max(100),
    choice: z.string().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("select"),
    candidates: z.array(z.string().min(1).max(120)).max(3),
  }),
  z.strictObject({
    // The agent can request a trusted structural transformation, not code.
    // Candidate membership and authorization are checked by mutateCanvas.
    kind: z.literal("canvas-view"),
    nodeId: z.string().min(1).max(80),
    mode: z.enum(["explore", "connections", "compare", "plan"]),
  }),
  z.strictObject({
    kind: z.literal("artifact"),
    artifactId: z.enum(["main", "invitation"]),
    content: z.string().min(1).max(10000),
  }),
]);

const ActionInterpretationSchema = z.object({
  presentation: PresentationSchema.optional(),
  workActions: z.array(WorkActionSchema).min(1).max(16).optional(),
  outcome: OutcomeSpecSchema.optional(),
  targetType: z.enum(["movie", "tv_show", "artist", "place"]).optional(),
  actions: z.array(ConversationActionSchema).max(8).optional(),
  supported: z.boolean().default(true),
  intent: z.enum(["goal", "revision", "unsupported"]).optional(),
  kind: z.enum(["gathering", "creative", "discovery"]),
  goal: z.string().max(3000),
  budget: z.number().min(0).max(1000000).optional(),
  duration: z.number().int().min(15).max(1440).optional(),
  wording: z.string().min(1).max(10000).optional(),
});

const ConversationInterpretationSchema = z
  .object({
    intent: z.enum(["conversation", "clarification"]),
    presentation: PresentationSchema.optional(),
    reply: z.string().trim().min(1).max(6000),
    replyEvidenceIds: z.array(z.string().max(500)).max(80).default([]),
  })
  .transform((value) => ({
    ...value,
    supported: true,
    kind: "discovery" as const,
    goal: "",
    workActions: undefined,
    actions: undefined,
    outcome: undefined,
    targetType: undefined,
    budget: undefined,
    duration: undefined,
    wording: undefined,
  }));

export const LiveDecisionSchema = z.union([
  ConversationInterpretationSchema,
  ActionInterpretationSchema.extend({
    intent: z.enum(["goal", "revision"]),
  }),
]);

export const InterpretationSchema = z.union([
  ConversationInterpretationSchema,
  ActionInterpretationSchema,
]);

export const TurnSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("canvas"),
    surfaceId: z.string().min(1).max(80),
    mutation: CanvasMutationSchema,
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("work"),
    actions: z.array(WorkActionSchema).min(1).max(16),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("outcome"),
    outcome: OutcomeSpecSchema,
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("personal-profile"),
    name: z.string().trim().min(1).max(60),
    artist: z.string().trim().min(1).max(100),
    film: z.string().trim().min(1).max(100).optional(),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("connection"),
    candidateId: z.string(),
    targetType: z.enum(["artist", "movie"]),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("place-example"),
    city: z.enum(["Tokyo", "Amsterdam", "Chicago"]),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("recall"),
    preferenceId: z.string().min(1),
    participantId: z.string().min(1),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("baseline"),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("message"),
    context: z
      .strictObject({ artifactId: z.string().min(1).max(200) })
      .optional(),
    text: z.string().trim().min(1).max(3000),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("sample"),
    example: z.enum(["common", "short", "budget"]).optional(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("constraints"),
    budget: z.number().min(0).max(1000000).optional(),
    duration: z.number().int().min(15).max(1440).optional(),
    location: z.string().trim().min(1).max(100).optional(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("participant"),
    reviewId: z.string().uuid().optional(),
    participant: ParticipantSchema,
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("catalogue"),
    options: z.array(CandidateInputSchema).min(1).max(30),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("artifact-lock"),
    artifactId: z.string().min(1),
    locked: z.boolean(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("artifact"),
    artifactId: z.string(),
    content: z.string().min(1).max(10000),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("resolve"),
    entityId: z.string(),
    choiceId: z.string(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("simulation"),
    mode: z.enum([
      "none",
      "empty",
      "timeout",
      "auth",
      "rate-limit",
      "malformed",
    ]),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("memory"),
    preferenceId: z.string(),
    operation: z.enum(["save", "delete"]),
    version: z.number().int().nonnegative(),
  }),
]);

export type Task = z.infer<typeof TaskSchema>;

export type Turn = z.infer<typeof TurnSchema>;

export type CandidateInput = z.infer<typeof CandidateInputSchema>;

export type Candidate = z.infer<typeof CandidateSchema>;

export type Participant = z.infer<typeof ParticipantSchema>;

export type Preference = z.infer<typeof PreferenceSchema>;

export type Evidence = z.infer<typeof EvidenceSchema>;

export type Entity = z.infer<typeof EntitySchema>;

export type Artifact = z.infer<typeof ArtifactSchema>;

export type ToolResult<T> = Omit<z.infer<typeof ToolResultSchema>, "data"> & {
  data: T;
};

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), task: TaskSchema }),
  z.object({ type: z.literal("done"), task: TaskSchema }),
  z.object({
    type: z.literal("action"),
    message: z.string(),
    activity: AgentActivitySchema.optional(),
    phase: z
      .enum([
        "accepted",
        "understanding",
        "responding",
        "awaiting_input",
        "retrieving",
        "evaluating",
        "composing",
        "awaiting_approval",
        "completed",
        "partial",
        "failed",
        "superseded",
        "interrupted",
      ])
      .optional(),
    runId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

export type Event = z.infer<typeof EventSchema>;

export type TaskBrief = z.infer<typeof BriefSchema>;

export type ResolvedEntity = Entity;

export type EvidenceRecord = Evidence;

export type ExecutionTrace = z.infer<typeof TraceSchema>;

/** Editors supply an action; the controller attaches the current optimistic version. */
export type WithoutVersion<T> = T extends { version: number }
  ? Omit<T, "version">
  : never;

export type TaskAction = WithoutVersion<Turn>;

/** Model proposals use the schema's input type; defaults are applied during validation. */
export type ModelInterpretation = z.input<typeof InterpretationSchema> & {
  actions?: z.input<typeof ActionInterpretationSchema>["actions"];
};
