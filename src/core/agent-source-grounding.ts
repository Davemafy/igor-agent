import type { ResearchSource } from "../tools/live-research";

/**
 * Ground document citations only to sources observed in the current run.
 * Models sometimes use a source URL, a persisted evidence ID, or inline
 * [web-N] citations rather than the requested short ID. Unrecognized tokens
 * are never guessed, renumbered, or treated as evidence.
 */
export function groundDocumentSources(
  requested: string[],
  content: string,
  observed: ResearchSource[],
  taskId: string,
  runId: string,
): { ids: string[]; rejected: string[] } {
  const accepted = new Set<string>();
  const rejected: string[] = [];

  for (const reference of requested) {
    const matches = observed.filter((source) =>
      [
        source.id,
        source.url,
        `${taskId}:agent:${runId}:${source.id}`,
      ].includes(reference),
    );

    if (matches.length === 1) {
      accepted.add(matches[0].id);
    } else {
      rejected.push(reference);
    }
  }

  // A literal inline reference is attributable to an actual observation,
  // not an invitation to backfill missing, unrelated references.
  for (const source of observed) {
    const escapedId = source.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shortCitation = new RegExp(`\\[${escapedId}\\]`, "i");

    if (shortCitation.test(content) || content.includes(source.url)) {
      accepted.add(source.id);
    }
  }

  return {
    ids: [...accepted],
    rejected,
  };
}
