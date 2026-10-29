import type { Task } from "@/core/contracts";
import { hasTaskArtifact } from "@/core/conversation-focus";

const key = (task: Task) => `igor-artifact-focus:${task.id}`;

export function readArtifactView(task: Task): string | null {
  try {
    const view = JSON.parse(localStorage.getItem(key(task)) || "null");

    return view?.goalId === (task.work?.activeGoalId ?? null) &&
      typeof view.artifactId === "string" &&
      view.artifactId.startsWith("document:") &&
      hasTaskArtifact(task, view.artifactId)
      ? view.artifactId
      : null;
  } catch {
    return null;
  }
}

export function rememberArtifactView(task: Task, artifactId: string) {
  if (!hasTaskArtifact(task, artifactId)) {
    return;
  }

  try {
    localStorage.setItem(
      key(task),
      JSON.stringify({
        artifactId,
        goalId: task.work?.activeGoalId ?? null,
      }),
    );
  } catch {
    /* Browser storage is optional view metadata. */
  }
}

export function visibleArtifactContext(task: Task) {
  if (typeof document === "undefined") {
    return undefined;
  }

  // Read this tab's visible object, never another tab's storage selection.
  const nodes = document.querySelectorAll("[data-active-artifact-id]");

  for (const node of nodes) {
    const artifactId = node.getAttribute("data-active-artifact-id");

    if (
      node.getAttribute("data-workspace-id") === task.id &&
      artifactId &&
      hasTaskArtifact(task, artifactId)
    ) {
      return { artifactId };
    }
  }

  return undefined;
}
