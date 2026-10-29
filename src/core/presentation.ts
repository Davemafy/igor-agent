import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\w:. -]+$/);
const copy = z.string().max(12000);
const base = { id, title: z.string().max(160).optional() };
const refs = z.array(z.string().min(1).max(150)).max(30);
const row = z.strictObject({
  id,
  cells: z.array(z.string().max(1000)).min(1).max(12),
  evidenceIds: refs.default([]),
});
const QuestionFieldSchema = z
  .strictObject({
    id,
    label: z.string().min(1).max(120),
    type: z.enum(["text", "number", "date", "choice"]),
    required: z.boolean().default(true),
    binding: z
      .enum([
        "budget",
        "budget-per-person",
        "duration-minutes",
        "duration-hours",
        "location",
      ])
      .optional(),
    placeholder: z.string().max(100).optional(),
    options: z.array(z.string().min(1).max(120)).min(2).max(8).optional(),
  })
  .superRefine((field, ctx) => {
    if (
      (field.type === "choice") !== Boolean(field.options) ||
      (field.options && new Set(field.options).size !== field.options.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Only choice fields have distinct options.",
      });
    }
  });
export const PresentationNodeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.enum(["stack", "columns", "tabs"]),
    children: z.array(id).min(1).max(12),
  }),
  z.strictObject({ ...base, type: z.literal("text"), text: copy }),
  z.strictObject({
    ...base,
    type: z.literal("findings"),
    items: z
      .array(
        z.strictObject({
          text: z.string().max(2000),
          evidenceIds: refs.default([]),
        }),
      )
      .max(20),
  }),
  z.strictObject({ ...base, type: z.literal("sources"), evidenceIds: refs }),
  z.strictObject({
    ...base,
    type: z.literal("table"),
    columns: z.array(z.string().max(80)).min(1).max(12),
    rows: z.array(row).max(100),
  }),
  z.strictObject({
    ...base,
    type: z.literal("chart"),
    tableId: id,
    labelColumn: z.number().int().min(0).max(11),
    valueColumn: z.number().int().min(0).max(11),
    unit: z.string().max(30).default(""),
  }),
  z.strictObject({
    ...base,
    type: z.literal("document"),
    // Source-linked visual references, never arbitrary model-supplied URLs.
    media: z
      .array(
        z.strictObject({
          candidateId: z.string().min(1).max(150),
          alt: z.string().trim().min(1).max(180),
          caption: z.string().trim().max(280).optional(),
        }),
      )
      .max(4)
      .optional(),
    artifactId: z.string().max(100).optional(),
    content: copy.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("timeline"),
    items: z
      .array(
        z.strictObject({
          id,
          label: z.string().max(160),
          detail: z.string().max(2000),
          candidateId: z.string().max(150).optional(),
        }),
      )
      .max(30),
  }),
  z.strictObject({
    ...base,
    type: z.enum(["discovery", "spatial"]),
    candidateIds: refs,
  }),
  z.strictObject({ ...base, type: z.literal("activity") }),
  z.strictObject({
    ...base,
    type: z.literal("question"),
    subject: z.string().trim().min(1).max(60).default("you"),
    prompt: z.string().min(1).max(500),
    fields: z.array(QuestionFieldSchema).min(1).max(6),
  }),
]);
export type PresentationNode = z.infer<typeof PresentationNodeSchema>;

/** A finite, application-owned vocabulary. No HTML, CSS, URLs, event handlers or executable code. */
export const PresentationSchema = z
  .strictObject({
    id,
    title: z.string().min(1).max(160),
    basis: z.enum([
      "general-knowledge",
      "user-supplied",
      "retrieved-evidence",
      "draft",
    ]),
    root: id,
    nodes: z.array(PresentationNodeSchema).min(1).max(32),
  })
  .superRefine((surface, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(surface)).length > 60000) {
      ctx.addIssue({
        code: "custom",
        message: "Composition exceeds the shared-state size budget.",
      });
    }

    const byId = new Map(surface.nodes.map((n) => [n.id, n]));
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    if (byId.size !== surface.nodes.length) {
      fail("Component IDs must be unique.");
    }

    const seen = new Set<string>();

    function visit(key: string, ancestors: Set<string>) {
      const node = byId.get(key);

      if (!node || ancestors.has(key) || ancestors.size > 5) {
        fail("Invalid, cyclic or excessive component nesting.");

        return;
      }

      if (seen.has(key)) {
        fail("A component must have one parent.");

        return;
      }

      seen.add(key);

      if ("children" in node) {
        node.children.forEach((child) =>
          visit(child, new Set([...ancestors, key])),
        );
      }

      if (
        node.type === "document" &&
        Boolean(node.artifactId) === (node.content !== undefined)
      ) {
        fail(
          "Document must bind an artifact or supply draft content, exclusively.",
        );
      }

      if (
        node.type === "table" &&
        node.rows.some((r) => r.cells.length !== node.columns.length)
      ) {
        fail("Table cells must match columns.");
      }

      if (
        node.type === "table" &&
        new Set(node.rows.map((r) => r.id)).size !== node.rows.length
      ) {
        fail("Row IDs must be unique.");
      }

      if (
        node.type === "timeline" &&
        new Set(node.items.map((r) => r.id)).size !== node.items.length
      ) {
        fail("Step IDs must be unique.");
      }

      if (
        node.type === "question" &&
        new Set(node.fields.map((field) => field.id)).size !==
          node.fields.length
      ) {
        fail("Question field IDs must be unique.");
      }

      if (node.type === "chart") {
        const table = byId.get(node.tableId);

        if (
          table?.type !== "table" ||
          Math.max(node.labelColumn, node.valueColumn) >=
            table.columns.length ||
          table.rows.some(
            (r) =>
              !r.cells[node.valueColumn].trim() ||
              !Number.isFinite(Number(r.cells[node.valueColumn])),
          )
        ) {
          fail(
            "Chart requires an existing table with a finite numeric column.",
          );
        }
      }
    }

    visit(surface.root, new Set());

    if (seen.size !== surface.nodes.length) {
      fail("Every component must be reachable from root.");
    }
  });
export type Presentation = z.infer<typeof PresentationSchema>;
export const CanvasStateSchema = z.object({
  source: z.enum(["agent", "adapter"]).default("agent"),
  surface: PresentationSchema,
  previous: z.array(PresentationSchema).max(4).default([]),
  selectedCandidateId: z.string().nullable().default(null),
  // These direct, owner-scoped canvas choices survive reload and model replies.
  // They never grant permissions or manufacture cultural evidence.
  comparisonIds: refs.max(3).default([]),
  viewModes: z
    .record(z.string(), z.enum(["explore", "connections", "compare", "plan"]))
    .default({}),
  itineraryIds: refs.default([]),
  filters: z.record(z.string(), z.string().max(200)).default({}),
  chartAxes: z.record(z.string(), z.number().int().min(0).max(11)).default({}),
  itineraryDays: z
    .record(z.string(), z.number().int().min(1).max(14))
    .default({}),
  completed: z.array(z.string().max(180)).max(100).default([]),
  answers: z
    .record(
      z.string().max(180),
      z.record(z.string().max(80), z.string().max(2000)),
    )
    .default({}),
});
export type CanvasState = z.infer<typeof CanvasStateSchema>;
export const CanvasMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("answer"),
    nodeId: id,
    values: z.record(z.string().max(80), z.string().max(2000)),
  }),
  z.strictObject({
    operation: z.literal("edit"),
    nodeId: id,
    content: z.string().min(1).max(12000),
  }),
  z.strictObject({
    operation: z.literal("filter"),
    nodeId: id,
    value: z.string().max(200),
  }),
  z.strictObject({
    operation: z.literal("chart-axis"),
    nodeId: id,
    valueColumn: z.number().int().min(0).max(11),
  }),
  z.strictObject({
    operation: z.literal("select"),
    nodeId: id,
    candidateId: z.string(),
  }),
  z.strictObject({
    operation: z.literal("compare-selection"),
    nodeId: id,
    candidateId: z.string().min(1).max(150),
  }),
  z.strictObject({
    operation: z.literal("view"),
    nodeId: id,
    mode: z.enum(["explore", "connections", "compare", "plan"]),
  }),
  z.strictObject({
    operation: z.literal("itinerary"),
    nodeId: id,
    candidateIds: refs,
  }),
  z.strictObject({
    operation: z.literal("reorder"),
    nodeId: id,
    itemIds: refs,
  }),
  z.strictObject({
    operation: z.literal("itinerary-day"),
    nodeId: id,
    candidateId: z.string().min(1).max(150),
    day: z.number().int().min(0).max(14),
  }),
  z.strictObject({ operation: z.literal("toggle"), nodeId: id, itemId: id }),
]);
export type CanvasMutation = z.infer<typeof CanvasMutationSchema>;

type GroundingContext = {
  candidates: {
    id: string;
    freshness: string;
    imageUrl?: string | null;
    sample?: boolean;
  }[];
  evidence: { id: string }[];
  artifacts: { id: string }[];
  messages?: { role: string; text: string }[];
  brief?: { participants: { id: string; name: string }[] };
};

export function validatePresentation(
  value: unknown,
  context: GroundingContext,
): Presentation {
  const surface = PresentationSchema.parse(value);
  const evidence = new Set(context.evidence.map((e) => e.id));
  const candidates = new Set(context.candidates.map((c) => c.id));

  for (const node of surface.nodes) {
    if (node.type === "document" && node.media) {
      const used = new Set<string>();

      for (const image of node.media) {
        const candidate = context.candidates.find(
          (item) => item.id === image.candidateId,
        );

        if (
          used.has(image.candidateId) ||
          !candidate ||
          candidate.sample ||
          candidate.freshness !== "current" ||
          !candidate.imageUrl ||
          !candidate.imageUrl.startsWith("https://images.qloo.com/")
        ) {
          throw new Error(
            "Document images must reference distinct, current provider-backed candidates.",
          );
        }

        used.add(image.candidateId);
      }
    }

    if (node.type === "question" && !["you", "group"].includes(node.subject)) {
      const subject = node.subject.toLocaleLowerCase();
      const known =
        context.brief?.participants.some((person) =>
          [person.id, person.name].some(
            (value) => value.toLocaleLowerCase() === subject,
          ),
        ) ||
        context.messages?.some(
          (message) =>
            message.role === "user" &&
            message.text.toLocaleLowerCase().includes(subject),
        );

      if (!known) {
        throw new Error("Question subject must be supplied by the user.");
      }
    }

    const ids =
      node.type === "sources"
        ? node.evidenceIds
        : node.type === "findings"
          ? node.items.flatMap((i) => i.evidenceIds)
          : node.type === "table"
            ? node.rows.flatMap((i) => i.evidenceIds)
            : [];

    if (ids.some((key) => !evidence.has(key))) {
      throw new Error("Presentation references unavailable evidence.");
    }

    const places =
      "candidateIds" in node
        ? node.candidateIds
        : node.type === "timeline"
          ? node.items.flatMap((i) => (i.candidateId ? [i.candidateId] : []))
          : [];

    if (places.some((key) => !candidates.has(key))) {
      throw new Error("Presentation references unavailable objects.");
    }

    if (
      node.type === "document" &&
      node.artifactId &&
      !context.artifacts.some((a) => a.id === node.artifactId)
    ) {
      throw new Error("Presentation references unavailable artifact.");
    }
  }

  return surface;
}

export function installPresentation(
  previous: CanvasState | undefined,
  surface: Presentation,
): CanvasState {
  return CanvasStateSchema.parse({
    ...previous,
    source: "agent",
    surface,
    previous: previous
      ? [previous.surface, ...previous.previous]
          .filter((s) => s.id !== surface.id)
          .slice(0, 4)
      : [],
  });
}

/** Runs inside the existing optimistic task transaction. It never calls inference or Qloo. */
export function mutateCanvas(
  canvas: CanvasState,
  surfaceId: string,
  mutation: CanvasMutation,
  context: GroundingContext,
) {
  if (canvas.surface.id !== surfaceId) {
    throw new Error("This canvas was replaced. Reload before editing.");
  }

  const node = canvas.surface.nodes.find((n) => n.id === mutation.nodeId);

  if (!node) {
    throw new Error("Component not found.");
  }

  switch (mutation.operation) {
    case "answer": {
      if (node.type !== "question") {
        throw new Error("This component does not accept answers.");
      }

      if (
        Object.keys(mutation.values).some(
          (key) => !node.fields.some((field) => field.id === key),
        )
      ) {
        throw new Error("Unknown question field.");
      }

      const values: Record<string, string> = {};

      for (const field of node.fields) {
        const value = (mutation.values[field.id] ?? "").trim();

        if (field.required && !value) {
          throw new Error(`Please answer ${field.label}.`);
        }

        if (
          value &&
          field.type === "choice" &&
          !field.options?.includes(value)
        ) {
          throw new Error("Choose an offered answer.");
        }

        if (
          value &&
          field.type === "number" &&
          !Number.isFinite(Number(value))
        ) {
          throw new Error("Enter a valid number.");
        }

        if (
          value &&
          field.type === "date" &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 10) !== value)
        ) {
          throw new Error("Enter a valid date.");
        }

        values[field.id] = value;
      }

      canvas.answers[`${canvas.surface.id}:${node.id}`] = values;
      break;
    }

    case "edit":
      if (node.type !== "document" || node.artifactId) {
        throw new Error("Only an authored draft can be edited here.");
      }

      node.content = mutation.content;
      break;
    case "filter":
      if (node.type !== "table" && node.type !== "discovery") {
        throw new Error("This component does not support filters.");
      }

      canvas.filters[node.id] = mutation.value;
      break;

    case "chart-axis": {
      if (node.type !== "chart") {
        throw new Error("Only a chart can change its measure.");
      }

      const table = canvas.surface.nodes.find((n) => n.id === node.tableId);

      if (
        table?.type !== "table" ||
        mutation.valueColumn >= table.columns.length ||
        mutation.valueColumn === node.labelColumn ||
        table.rows.length === 0 ||
        table.rows.some(
          (row) =>
            !row.cells[mutation.valueColumn]?.trim() ||
            !Number.isFinite(Number(row.cells[mutation.valueColumn])),
        )
      ) {
        throw new Error("Choose an existing numeric comparison column.");
      }

      canvas.chartAxes[node.id] = mutation.valueColumn;
      break;
    }

    case "select":
      if (!(
        (node.type === "spatial" || node.type === "discovery") &&
        node.candidateIds.includes(mutation.candidateId)
      )) {
        throw new Error("Select an offered object.");
      }

      if (
        !context.candidates.some(
          (c) => c.id === mutation.candidateId && c.freshness === "current",
        )
      ) {
        throw new Error("Select a current object.");
      }

      canvas.selectedCandidateId = mutation.candidateId;
      break;

    case "compare-selection": {
      if (
        (node.type !== "discovery" && node.type !== "spatial") ||
        !node.candidateIds.includes(mutation.candidateId) ||
        !context.candidates.some(
          (candidate) =>
            candidate.id === mutation.candidateId &&
            candidate.freshness === "current",
        )
      ) {
        throw new Error("Compare only current objects on this canvas.");
      }

      canvas.comparisonIds = canvas.comparisonIds.includes(mutation.candidateId)
        ? canvas.comparisonIds.filter((key) => key !== mutation.candidateId)
        : [...canvas.comparisonIds, mutation.candidateId].slice(-3);

      if (
        canvas.viewModes[node.id] === "compare" &&
        canvas.comparisonIds.filter((key) => node.candidateIds.includes(key))
          .length < 2
      ) {
        canvas.viewModes[node.id] = "explore";
      }

      break;
    }

    case "view": {
      if (node.type !== "discovery" && node.type !== "spatial") {
        throw new Error(
          "Only discovery surfaces can morph into connected work.",
        );
      }

      const current = (candidateId: string) =>
        node.candidateIds.includes(candidateId) &&
        context.candidates.some(
          (candidate) =>
            candidate.id === candidateId && candidate.freshness === "current",
        );

      if (
        mutation.mode === "compare" &&
        canvas.comparisonIds.filter(current).length < 2
      ) {
        throw new Error("Select two current options before comparing.");
      }

      if (mutation.mode === "plan") {
        if (
          !canvas.selectedCandidateId ||
          !current(canvas.selectedCandidateId)
        ) {
          throw new Error("Choose a current option before making a plan.");
        }

        // Preserve the existing itinerary when returning to the plan. Adding
        // a newly selected object is an explicit user edit, not model inference.
        if (!canvas.itineraryIds.includes(canvas.selectedCandidateId)) {
          canvas.itineraryIds = [
            ...canvas.itineraryIds.filter((key) =>
              context.candidates.some(
                (candidate) =>
                  candidate.id === key && candidate.freshness === "current",
              ),
            ),
            canvas.selectedCandidateId,
          ].slice(0, 30);
        }
      }

      canvas.viewModes[node.id] = mutation.mode;
      break;
    }

    case "itinerary": {
      if (node.type !== "spatial" && node.type !== "discovery") {
        throw new Error("This component cannot edit the itinerary.");
      }

      const allowed = new Set([...canvas.itineraryIds, ...node.candidateIds]);

      if (
        new Set(mutation.candidateIds).size !== mutation.candidateIds.length ||
        mutation.candidateIds.some(
          (key) =>
            !allowed.has(key) ||
            !context.candidates.some(
              (c) => c.id === key && c.freshness === "current",
            ),
        )
      ) {
        throw new Error("Itinerary requires unique, current objects.");
      }

      canvas.itineraryIds = mutation.candidateIds;

      for (const key of Object.keys(canvas.itineraryDays)) {
        if (!mutation.candidateIds.includes(key)) {
          delete canvas.itineraryDays[key];
        }
      }

      break;
    }

    case "itinerary-day": {
      if (
        (node.type !== "spatial" && node.type !== "discovery") ||
        !canvas.itineraryIds.includes(mutation.candidateId) ||
        !context.candidates.some(
          (candidate) =>
            candidate.id === mutation.candidateId &&
            candidate.freshness === "current",
        )
      ) {
        throw new Error("Assign days only to current itinerary stops.");
      }

      if (mutation.day === 0) {
        delete canvas.itineraryDays[mutation.candidateId];
      } else {
        canvas.itineraryDays[mutation.candidateId] = mutation.day;
      }

      break;
    }

    case "reorder":
      if (
        node.type !== "timeline" ||
        mutation.itemIds.length !== node.items.length ||
        new Set(mutation.itemIds).size !== node.items.length ||
        mutation.itemIds.some((key) => !node.items.some((i) => i.id === key))
      ) {
        throw new Error("Reorder requires the exact existing steps.");
      }

      node.items = mutation.itemIds.map((key) =>
        node.items.find((i) => i.id === key)!,
      );
      break;

    case "toggle": {
      if (
        node.type !== "timeline" ||
        !node.items.some((i) => i.id === mutation.itemId)
      ) {
        throw new Error("Step not found.");
      }

      const key = `${node.id}:${mutation.itemId}`;
      canvas.completed = canvas.completed.includes(key)
        ? canvas.completed.filter((i) => i !== key)
        : [...canvas.completed, key];
      break;
    }
  }

  return CanvasStateSchema.parse(canvas);
}
