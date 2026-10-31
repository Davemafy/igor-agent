"use client";

import { useEffect, useRef, useState } from "react";
import type { Task, TaskAction } from "@/core/contracts";
import {
  createWorkspace as requestNewWorkspace,
  fetchWorkspace,
  fetchWorkspaceHistory,
  fetchTurnJournal,
  newestWorkspace,
  pendingTurn,
  rememberTurn,
  recoverTurnJournal,
  readTurnEvents,
  submitTurn,
  TurnRequestError,
  completedTurnAfter,
  type WorkspaceSummary,
} from "./workspace-api";

export type WorkspaceView =
  "programme" | "options" | "invitation" | "evidence" | "connections" | "keep";

import type { TurnFeedback } from "./turn-feedback";
import { morphLayout } from "./mobile-transitions";

const savedWorkspaceKey = "igor-task";

export function useWorkspace() {
  const [task, setTask] = useState<Task | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeView, setActiveView] = useState<WorkspaceView>("programme");
  const [executionMessage, setExecutionMessage] = useState("");
  const sending = useRef(false);
  const [feedback, setFeedback] = useState<TurnFeedback | null>(null);
  const [history, setHistory] = useState<WorkspaceSummary[]>([]);

  useEffect(() => {
    let active = true;
    const recovery = new AbortController();

    async function restoreWorkspace() {
      try {
        const savedId =
          new URLSearchParams(location.search).get("task") ||
          localStorage.getItem(savedWorkspaceKey);
        const savedTask = savedId ? await fetchWorkspace(savedId) : null;
        const workspace = savedTask ?? (await requestNewWorkspace());

        if (active) {
          setTask(workspace);
          localStorage.setItem(savedWorkspaceKey, workspace.id);
          setIsLoadingWorkspace(false);
          const pending = pendingTurn(workspace.id);

          if (pending) {
            for await (const journal of recoverTurnJournal(
              workspace.id,
              pending,
              recovery.signal,
            )) {
              if (
                !active ||
                localStorage.getItem(savedWorkspaceKey) !== workspace.id ||
                pendingTurn(workspace.id)?.turnId !== pending.turnId
              ) {
                break;
              }

              setTask((current) => newestWorkspace(current, journal.task));
              const last = journal.events.at(-1);

              if (last) {
                rememberTurn(workspace.id, {
                  turnId: pending.turnId,
                  after: last.sequence,
                });
              }

              if (
                journal.status !== "accepted" &&
                journal.status !== "running"
              ) {
                rememberTurn(workspace.id, null);
                setExecutionMessage("");

                if (
                  ["failed", "interrupted", "superseded"].includes(
                    journal.status,
                  )
                ) {
                  setErrorMessage(
                    journal.task.error ||
                      "The saved request stopped. Your work is preserved.",
                  );
                }
              } else {
                setExecutionMessage("Restoring saved execution progress");
              }
            }
          }
        }
      } catch {
        if (active) {
          setErrorMessage(
            "The local workspace could not start. Refresh to retry.",
          );
        }
      } finally {
        if (active) {
          setIsLoadingWorkspace(false);
        }
      }
    }

    void restoreWorkspace();

    return () => {
      active = false;
      recovery.abort();
    };
  }, []);

  async function createWorkspace() {
    if (sending.current) {
      return;
    }

    setIsBusy(true);
    setIsLoadingWorkspace(true);
    setErrorMessage("");

    try {
      const workspace = await requestNewWorkspace();
      setTask(workspace);
      setFeedback(null);
      localStorage.setItem(savedWorkspaceKey, workspace.id);
      setActiveView("programme");

      return workspace;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not load.",
      );
    } finally {
      setIsBusy(false);
      setIsLoadingWorkspace(false);
    }
  }

  async function openWorkspace(id: string) {
    if (sending.current) {
      return false;
    }

    setIsLoadingWorkspace(true);

    try {
      const workspace = await fetchWorkspace(id);

      if (!workspace) {
        setErrorMessage("That conversation is no longer available.");

        return false;
      }

      setTask(workspace);
      setFeedback(null);
      localStorage.setItem(savedWorkspaceKey, id);

      return true;
    } finally {
      setIsLoadingWorkspace(false);
    }
  }

  async function loadHistory() {
    const workspaces = await fetchWorkspaceHistory();

    if (!workspaces) {
      throw new Error("Could not load saved discoveries.");
    }

    setHistory(workspaces);
  }

  async function sendTurn(action: TaskAction, targetTask?: Task) {
    const currentTask = targetTask ?? task;

    if (!currentTask || sending.current) {
      return;
    }

    sending.current = true;
    setIsBusy(true);
    setErrorMessage("");
    const input = action.type === "message" ? action.text : "";
    const startedAt = Date.now();
    setFeedback({
      input,
      action,
      startedAt,
      messageCount: currentTask.messages.length,
      state: "running",
      steps: [],
      activities: [],
    });
    setExecutionMessage("Waiting for Igor");
    let failed = false;
    let morphed = false;
    const clientTurnId = crypto.randomUUID();
    rememberTurn(currentTask.id, { turnId: clientTurnId, after: 0 });

    try {
      const response = await submitTurn(currentTask, action, clientTurnId);

      for await (const event of readTurnEvents(response, 45000, {
        onEventId: (after) =>
          rememberTurn(currentTask.id, { turnId: clientTurnId, after }),
      })) {
        if (event.type === "state" || event.type === "done") {
          const previousVisual = Boolean(
            currentTask.canvas ||
            currentTask.work?.documents.length ||
            currentTask.work?.decisions.length,
          );
          const nextVisual = Boolean(
            event.task.canvas ||
            event.task.work?.documents.length ||
            event.task.work?.decisions.length,
          );
          const newSurface = Boolean(
            event.task.canvas &&
            event.task.canvas.surface.id !== currentTask.canvas?.surface.id,
          );
          const significantCanvasEdit =
            action.type === "canvas" &&
            ["edit", "filter", "chart-axis", "reorder"].includes(
              action.mutation.operation,
            );
          const significantWorkEdit =
            action.type === "work" &&
            action.actions.some((change) => change.kind === "edit");

          // State comes from the server; a UI transition never predicts a
          // completed operation or impersonates a backend result.
          if (
            !morphed &&
            nextVisual &&
            (!previousVisual ||
              newSurface ||
              (event.type === "done" &&
                ["message", "question"].includes(action.type)) ||
              significantCanvasEdit ||
              significantWorkEdit)
          ) {
            morphed = true;
            morphLayout(() =>
              setTask((current) => newestWorkspace(current, event.task)),
            );
          } else {
            setTask((current) => newestWorkspace(current, event.task));
          }

          const terminalError =
            event.type !== "done"
              ? ""
              : event.task.status === "error"
                ? event.task.error || "This reply could not finish."
                : action.type === "message" &&
                    !event.task.messages
                      .slice(currentTask.messages.length)
                      .some((message) => message.role === "assistant")
                  ? "Your message was saved, but Igor did not finish a reply. Try again."
                  : "";

          if (terminalError) {
            failed = true;
            setErrorMessage(terminalError);
            setFeedback((previous) =>
              previous
                ? {
                    ...previous,
                    state: "error",
                    error: terminalError,
                  }
                : previous,
            );
          }
        }

        if (event.type === "done" && event.task?.brief.outcome) {
          setActiveView("programme");
        } else if (
          event.type === "done" &&
          event.task?.brief.targetType === "place"
        ) {
          setActiveView("connections");
        }

        if (event.type === "action") {
          setExecutionMessage(event.message ?? "");

          if (event.message) {
            setFeedback((previous) =>
              previous
                ? {
                    ...previous,
                    activity: event.activity ?? previous.activity,
                    activities:
                      event.activity &&
                      !previous.activities?.some(
                        (item) =>
                          item.activity.eventId === event.activity?.eventId,
                      )
                        ? [
                            ...(previous.activities ?? []),
                            {
                              message: event.message,
                              activity: event.activity,
                            },
                          ].slice(-80)
                        : previous.activities,
                    steps:
                      previous.steps.at(-1) === event.message
                        ? previous.steps
                        : [...previous.steps, event.message],
                  }
                : previous,
            );
          }
        }

        if (event.type === "done" || event.type === "error") {
          rememberTurn(currentTask.id, null);
        }

        if (event.type === "error") {
          failed = true;
          setFeedback((previous) =>
            previous
              ? { ...previous, state: "error", error: event.message }
              : previous,
          );

          if (event.code === "conflict") {
            const latest = await fetchWorkspace(currentTask.id);

            if (latest) {
              setTask(latest);
            }
          }

          setErrorMessage(event.message ?? "Action rejected.");
        }
      }
    } catch (error) {
      failed = true;
      let message =
        error instanceof Error ? error.message : "The action could not finish.";

      if (error instanceof TurnRequestError && error.needsRefresh) {
        try {
          const latest = await fetchWorkspace(currentTask.id);

          if (latest) {
            setTask(latest);
          }
        } catch {
          message += " Refresh the page to load the latest workspace.";
        }
      }

      setErrorMessage(message);
      setFeedback((previous) =>
        previous ? { ...previous, state: "error", error: message } : previous,
      );
    } finally {
      setExecutionMessage("");

      if (!failed) {
        setFeedback((previous) =>
          previous ? { ...previous, state: "complete" } : previous,
        );
      }

      // The journal is authoritative when the network drops after admission.
      // Never automatically resend a paid call merely because SSE was lost.
      if (failed) {
        try {
          const recorded = await fetchTurnJournal(currentTask.id, clientTurnId);

          setTask((current) => newestWorkspace(current, recorded.task));

          if (recorded.status !== "accepted" && recorded.status !== "running") {
            rememberTurn(currentTask.id, null);
          }

          if (
            recorded.status === "completed" ||
            recorded.status === "awaiting_input"
          ) {
            const latest = await fetchWorkspace(currentTask.id);

            if (latest) {
              setTask(latest);
              failed = false;
              setErrorMessage("");
              setFeedback((previous) =>
                previous
                  ? { ...previous, state: "complete", error: undefined }
                  : previous,
              );
            }
          } else if (
            recorded.status === "running" ||
            recorded.status === "accepted"
          ) {
            setErrorMessage(
              "Igor accepted this message. Its progress is saved; reload to check the result. No duplicate request was sent.",
            );
          }
        } catch {
          // Request may have failed before the server accepted the turn.
        }
      }

      // A transport error can happen after the server saved a turn. Reconcile
      // before allowing a retry, so messages and optimistic versions stay aligned.
      if (failed) {
        try {
          const latest = await fetchWorkspace(currentTask.id);

          if (latest) {
            setTask(latest);

            if (
              completedTurnAfter(
                latest,
                currentTask.brief.version,
                currentTask.messages.length,
              )
            ) {
              failed = false;
              setErrorMessage("");
              setFeedback((previous) =>
                previous
                  ? { ...previous, state: "complete", error: undefined }
                  : previous,
              );
            }
          }
        } catch {
          /* Keep the visible input and retry available. */
        }
      }

      // SSE and view-transition animations are not authoritative. Re-read
      // the committed task before making the composer available. This is
      // read-only: it never replays a model call or an external action.
      if (!failed) {
        try {
          const saved = await fetchWorkspace(currentTask.id);

          if (saved) {
            setTask((current) => newestWorkspace(current, saved));
          }
        } catch {
          // A completed stream remains usable if a later refresh fails.
          // Its persisted journal still permits read-only recovery.
        }
      }

      sending.current = false;
      setIsBusy(false);
    }
  }

  return {
    task,
    isLoadingWorkspace,
    acceptTask: setTask,
    isBusy,
    errorMessage,
    setErrorMessage,
    activeView,
    setActiveView,
    executionMessage,
    feedback,
    history,
    loadHistory,
    createWorkspace,
    openWorkspace,
    sendTurn,
  };
}
