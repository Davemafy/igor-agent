import { visibleArtifactContext } from "./artifact-focus";
import {
  EventSchema,
  TaskSchema,
  type Event,
  type Task,
  type TaskAction,
} from "@/core/contracts";

export type WorkspaceSummary = {
  id: string;
  goal: string;
  title?: string;
  preview?: string;
  updatedAt?: string | null;
};

export class TurnRequestError extends Error {
  constructor(
    message: string,
    readonly needsRefresh: boolean,
  ) {
    super(message);
  }
}

export async function createWorkspace(): Promise<Task> {
  const response = await fetch("/api/tasks", { method: "POST" });

  if (!response.ok) {
    throw new Error("Could not create workspace.");
  }

  return TaskSchema.parse(await response.json());
}

export async function fetchWorkspace(id: string): Promise<Task | null> {
  const response = await fetch(`/api/tasks/${id}`);

  if (response.status === 401 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Could not load workspace.");
  }

  return TaskSchema.parse(await response.json());
}

export async function fetchWorkspaceHistory(): Promise<
  WorkspaceSummary[] | null
> {
  const response = await fetch("/api/tasks");

  if (!response.ok) {
    return null;
  }

  const { tasks } = await response.json();

  return tasks;
}

export async function submitTurn(
  task: Task,
  action: TaskAction,
  clientTurnId: string = crypto.randomUUID(),
): Promise<Response> {
  const response = await fetch(`/api/tasks/${task.id}/turn`, {
    method: "POST",
    signal: AbortSignal.timeout(150000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...action,
      ...(action.type === "message"
        ? { context: action.context ?? visibleArtifactContext(task) }
        : {}),
      version: task.brief.version,
      clientTurnId,
      workspaceId: task.id,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new TurnRequestError(
      body.error ?? "Could not save the turn.",
      response.status === 409,
    );
  }

  return response;
}

export async function fetchTurnJournal(
  workspaceId: string,
  turnId: string,
  after = 0,
): Promise<{
  status: import("../core/turn-lifecycle").TurnStatus;
  task: Task;
  hasMore: boolean;
  lastSequence: number;
  events: Array<{ sequence: number; event: Event }>;
}> {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(workspaceId)}/turn?turnId=${encodeURIComponent(turnId)}&after=${after}`,
    { cache: "no-store" },
  );

  if (!res.ok) {
    throw new Error("The saved turn could not be recovered.");
  }

  const payload = await res.json();

  return {
    ...payload,
    task: TaskSchema.parse(payload.task),
    events: payload.events.map((row: { sequence: number; event: unknown }) => ({
      ...row,
      event: EventSchema.parse(row.event),
    })),
  };
}

export async function* readTurnEvents(
  response: Response,
  idleTimeoutMs = 45000,
  cursor?: { after?: number; onEventId?: (id: number) => void },
): AsyncGenerator<Event> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("No execution stream received.");
  }

  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  let lastId = cursor?.after ?? 0;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "The connection stopped responding. Your saved conversation will be checked before you retry.",
                ),
              ),
            idleTimeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const { value, done } = chunk;
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replace(/\r\n/g, "\n");
      let boundary = pending.indexOf("\n\n");

      while (boundary >= 0) {
        const packet = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);

        const dataLine = packet
          .split("\n")
          .find((line) => line.startsWith("data: "));

        const idLine = packet
          .split("\n")
          .find((line) => line.startsWith("id: "));
        const eventId = idLine ? Number(idLine.slice(4)) : null;

        if (
          dataLine &&
          (eventId === null ||
            (Number.isSafeInteger(eventId) && eventId > lastId))
        ) {
          const event = EventSchema.parse(JSON.parse(dataLine.slice(6)));

          if (eventId !== null) {
            lastId = eventId;
            cursor?.onEventId?.(eventId);
          }

          completed = event.type === "done" || event.type === "error";
          yield event;

          if (completed) {
            return;
          }
        }

        boundary = pending.indexOf("\n\n");
      }

      if (done) {
        throw new Error(
          "Execution stream ended before completion. Reload the workspace to check its saved state.",
        );
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** A dropped connection must not offer to replay an already completed turn. */
export function completedTurnAfter(
  task: Task,
  version: number,
  messageCount: number,
) {
  return (
    task.brief.version > version &&
    ["ready", "partial", "draft", "clarification"].includes(task.status) &&
    task.messages
      .slice(messageCount)
      .some((message) => message.role === "assistant")
  );
}

export type PendingTurn = { turnId: string; after: number };
const pendingKey = (workspace: string) => `igor-pending-turn:${workspace}`;

export function pendingTurn(workspace: string): PendingTurn | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(pendingKey(workspace)) || "null",
    );

    return value &&
      /^[a-f0-9-]{36}$/.test(value.turnId) &&
      Number.isSafeInteger(value.after) &&
      value.after >= 0
      ? value
      : null;
  } catch {
    return null;
  }
}

export function rememberTurn(workspace: string, value: PendingTurn | null) {
  try {
    if (value) {
      localStorage.setItem(pendingKey(workspace), JSON.stringify(value));
    } else {
      localStorage.removeItem(pendingKey(workspace));
    }
  } catch {
    /* Server journaling works even when browser storage is unavailable. */
  }
}

/** Read-only reconnect: paginates persisted events and polls the authoritative
 * snapshot. Never retries POST, provider calls or an external operation. */
export async function* recoverTurnJournal(
  workspace: string,
  turn: PendingTurn,
  signal?: AbortSignal,
) {
  let cursor = turn.after;

  for (let polls = 0; polls < 300 && !signal?.aborted; polls++) {
    const page = await fetchTurnJournal(workspace, turn.turnId, cursor);
    yield page;
    cursor = page.events.at(-1)?.sequence ?? cursor;

    if (
      !page.hasMore &&
      page.status !== "accepted" &&
      page.status !== "running"
    ) {
      return;
    }

    if (page.hasMore) {
      continue;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };

      const timer = setTimeout(finish, 1000);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

/** A late response can never visually roll back a newer saved correction. */
export function newestWorkspace(current: Task | null, incoming: Task): Task {
  return current?.id === incoming.id &&
    current.brief.version > incoming.brief.version
    ? current
    : incoming;
}
