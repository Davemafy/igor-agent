import type { Task } from "./contracts";

/** Add real imagery to draft documents only when the text actually references
 * a current, non-sample candidate with a provider-supplied image URL. */
export function sourceLinkedDocumentMedia(
  task: Pick<Task, "candidates">,
  content: string,
) {
  const plain = content.toLocaleLowerCase();

  return task.candidates
    .filter(
      (candidate) =>
        !candidate.sample &&
        candidate.freshness === "current" &&
        !!candidate.imageUrl &&
        candidate.name.trim().length > 2 &&
        plain.includes(candidate.name.toLocaleLowerCase()),
    )
    .slice(0, 3)
    .map((candidate) => ({
      candidateId: candidate.id,
      alt: `Provider image for ${candidate.name}`,
      caption: candidate.name,
    }));
}
