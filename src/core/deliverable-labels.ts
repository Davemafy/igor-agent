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
): string[] {
  const result = [...new Set(labels ?? [])];
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (content.trim().length < 180) {
    return result.slice(0, 6);
  }

  for (const key of requested) {
    const phrase = key.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
