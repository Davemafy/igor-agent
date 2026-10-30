/**
 * Models sometimes wrap low-risk document fields in singletons or paragraph
 * arrays. Normalize shape before the unchanged strict tool schema validates
 * the result. NEVER invent or substitute an evidence/source/candidate ID.
 */
export function normalizeAgentArguments(tool: string, raw: unknown): unknown {
  if (
    (tool !== "document.create" && tool !== "document.revise") ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return raw;
  }

  const value = raw as Record<string, unknown>;

  const list = (field: string, maximum: number): unknown => {
    const original = value[field];

    if (typeof original === "string") {
      return original ? [original] : [];
    }

    return Array.isArray(original)
      ? original.filter((item) => typeof item === "string").slice(0, maximum)
      : [];
  };

  let text: unknown = value.content;

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
