/**
 * Models sometimes wrap low-risk document fields in singletons or paragraph
 * arrays. Normalize shape before the unchanged strict tool schema validates
 * the result. NEVER invent or substitute an evidence/source/candidate ID.
 */
export function normalizeAgentArguments(
  tool: string,
  raw: unknown,
): unknown {
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
  const content = value.content;
  const text =
    Array.isArray(content) &&
    content.every((part) => typeof part === "string")
      ? content.join("\n\n")
      : content && typeof content === "object" && !Array.isArray(content)
        ? (content as Record<string, unknown>).markdown ??
          (content as Record<string, unknown>).text ??
          content
        : content;
  const normalized: Record<string, unknown> = {
    title:
      typeof value.title === "string"
        ? value.title.slice(0, 160)
        : value.title,
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
