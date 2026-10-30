/**
 * Reconcile a model's presentation label with the user's requested document
 * kind only when the authored title explicitly names that kind.
 *
 * A label is metadata, not factual verification or acceptance of its contents.
 * The usual source, cultural, budget and revision checks still apply.
 */
export function reconcileDeliverableLabels(
  title: string,
  content: string,
  labels: string[] | undefined,
  requested: string[],
  userRequest = "",
): string[] {
  const result = [...new Set(labels ?? [])];
  const normalizedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (content.trim().length < 180) {
    return result.slice(0, 6);
  }

  // The interpreter can call an "investment memo" a "proposal".
  // Repair the document *kind* only when both the user's request and the
  // authored title explicitly name it; never infer factual correctness.
  const normalizedRequest = userRequest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const kinds = [
    "memo",
    "report",
    "brief",
    "proposal",
    "plan",
    "invitation",
    "schedule",
    "comparison",
    "pitch",
    "letter",
  ];

  for (const kind of kinds) {
    if (
      ` ${normalizedTitle} `.includes(` ${kind} `) &&
      ` ${normalizedRequest} `.includes(` ${kind} `) &&
      !result.includes(kind)
    ) {
      result.push(kind);
    }
  }

  for (const key of requested) {
    const phrase = key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (
      phrase &&
      !result.includes(key) &&
      ` ${normalizedTitle} `.includes(` ${phrase} `)
    ) {
      result.push(key);
    }
  }

  return result.slice(0, 6);
}
