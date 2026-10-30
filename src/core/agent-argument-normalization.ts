/**
 * Models sometimes wrap low-risk document fields in singletons or paragraph
 * arrays. Normalize shape before the unchanged strict tool schema validates
 * the result. NEVER invent or substitute an evidence/source/candidate ID.
 */
export function normalizeAgentArguments(tool: string, raw: unknown): unknown {
  // The independent critique reads only persisted task state. Its arguments
  // are deliberately empty; discard model-invented context keys, never their
  // values, to avoid wasting an agent step on a harmless no-op payload.
  if (tool === "experience.critique" && raw && typeof raw === "object") {
    return {};
  }

  if (
    tool === "experience.compose" &&
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw)
  ) {
    const outer = raw as Record<string, unknown>;
    const keys = Object.keys(outer);

    // Only unwrap a single recognized wrapper or singleton action.
    // The unchanged strict WorkActionSchema validates every resulting action,
    // including denial of model-initiated approval and external writes.
    if (keys.length === 1) {
      const key = keys[0];
      const value = outer[key];

      if (
        key === "actions" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return { actions: [value] };
      }

      if (
        (key === "workActions" || key === "operations") &&
        Array.isArray(value)
      ) {
        return { actions: value };
      }

      if (
        (key === "payload" || key === "input") &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const nested = value as Record<string, unknown>;

        if (Array.isArray(nested.actions) && Object.keys(nested).length === 1) {
          return { actions: nested.actions };
        }
      }
    }

    return raw;
  }

  if (
    (tool !== "document.create" && tool !== "document.revise") ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return raw;
  }

  const outer = raw as Record<string, unknown>;
  const nested = ["arguments", "document", "payload", "input"]
    .map((key) => outer[key])
    .find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }

      const candidate = item as Record<string, unknown>;

      return "title" in candidate || "content" in candidate;
    });
  const value = (nested as Record<string, unknown> | undefined) ?? outer;

  const list = (field: string, maximum: number): unknown => {
    const original = value[field];

    if (typeof original === "string") {
      return original ? [original] : [];
    }

    if (!Array.isArray(original)) {
      return [];
    }

    return original
      .map((item) =>
        item && typeof item === "object" && "id" in item
          ? (item as { id: unknown }).id
          : item,
      )
      .filter((item) => typeof item === "string")
      .slice(0, maximum);
  };

  let text: unknown =
    value.content ?? value.markdown ?? value.body ?? value.text;

  if (Array.isArray(text) && text.every((part) => typeof part === "string")) {
    text = text.join("\n\n");
  } else if (text && typeof text === "object" && !Array.isArray(text)) {
    const structured = text as Record<string, unknown>;

    text = structured.markdown ?? structured.text ?? text;
  }

  const title = value.title;
  const normalized: Record<string, unknown> = {
    title: typeof title === "string" ? title.slice(0, 160) : title,
    content: typeof text === "string" ? text.slice(0, 10000) : text,
    sourceIds: list("sourceIds", 12),
    evidenceIds: list("evidenceIds", 30),
    candidateIds: list("candidateIds", 12),
    fulfills: list("fulfills", 6),
  };

  if (tool === "document.revise") {
    normalized.artifactId = value.artifactId;
  }

  return normalized;
}
