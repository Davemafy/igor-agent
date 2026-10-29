"use client";

import { useState } from "react";
import type { TurnFeedback } from "./turn-feedback";
import { ChevronDown } from "./workspace-icons";
import type { Task } from "@/core/contracts";
import { loadingFormat } from "./loading-format";

export function LoadingSurface({
  mode,
}: {
  mode: "thread" | "history" | "collection" | "output";
}) {
  return (
    <div
      className={`iw-placeholder iw-placeholder-${mode}`}
      role="status"
      aria-label="Loading your saved work"
    >
      <span className="iw-sr">Loading your saved work</span>
      <div aria-hidden="true">
        {mode === "thread" ? (
          <>
            <div className="iw-placeholder-user">
              <i className="iw-skeleton" />
              <i className="iw-skeleton" />
            </div>
            <div className="iw-placeholder-reply">
              <img
                src="/marketing/assets/brand/igor-mark-black.svg"
                width="24"
                height="24"
                alt=""
              />
              <i className="iw-skeleton" />
              <i className="iw-skeleton" />
              <i className="iw-skeleton" />
            </div>
          </>
        ) : mode === "history" ? (
          [0, 1, 2, 3].map((id) => (
            <div className="iw-placeholder-history-row" key={id}>
              <span>
                <i className="iw-skeleton" />
                <i className="iw-skeleton" />
              </span>
              <i className="iw-skeleton" />
            </div>
          ))
        ) : mode === "collection" ? (
          <div className="iw-placeholder-collection-grid">
            {[0, 1, 2].map((id) => (
              <div key={id}>
                <i className="iw-skeleton iw-placeholder-cover" />
                <i className="iw-skeleton" />
              </div>
            ))}
          </div>
        ) : (
          <div className="iw-placeholder-output">
            <i className="iw-skeleton" />
            <i className="iw-skeleton iw-placeholder-cover" />
            <i className="iw-skeleton" />
          </div>
        )}
      </div>
    </div>
  );
}

export function LoadingImage({ src, alt = "" }: { src: string; alt?: string }) {
  return <ImagePlaceholder key={src} src={src} alt={alt} />;
}

function ImagePlaceholder({ src, alt }: { src: string; alt: string }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span className="iw-loading-image" data-ready={ready || failed}>
      {!ready && !failed && (
        <span className="iw-skeleton iw-image-proof" aria-hidden="true" />
      )}
      {failed && (
        <span className="iw-image-unavailable">
          <img
            src="/marketing/assets/brand/igor-mark-black.svg"
            alt=""
            width="24"
            height="24"
          />
          <span>Image unavailable</span>
        </span>
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setReady(true)}
        onError={() => setFailed(true)}
        style={{ opacity: ready ? 1 : 0 }}
      />
    </span>
  );
}

export function AgentActivity({
  busy,
  feedback,
  message,
  task,
}: {
  busy: boolean;
  feedback: TurnFeedback | null;
  message: string;
  task?: Task | null;
}) {
  if (!busy || !feedback) {
    return null;
  }

  const activity = feedback.activity;
  const status = activity?.actionStatus;
  const title =
    status === "awaiting-approval"
      ? "Waiting for your review"
      : status === "blocked"
        ? "A step needs attention"
        : status === "failed"
          ? "A step could not finish"
          : activity?.kind === "tool-invocation" ||
              activity?.kind === "tool-result"
            ? "Working on your request"
            : feedback.action.type === "canvas" &&
                feedback.action.mutation.operation === "answer"
              ? "Working with your answers"
              : feedback.action.type === "message"
                ? "Considering your request"
                : "Saving your changes";
  // Only the visual placeholder changes; routing and execution stay server-owned.
  const format = loadingFormat(feedback.input || "", task);
  const events = (feedback.activities ?? [])
    .filter(
      (item) =>
        !["message-added", "task-started", "state-changed"].includes(
          item.activity.kind,
        ),
    )
    .slice(-6);
  const quiet =
    /^(Processing this turn|User message saved|Assistant message saved|Completed the turn)/i.test(
      message,
    );

  return (
    <div className="iw-agent-working">
      <div
        className="iw-agent-working-heading"
        role="status"
        aria-live="polite"
      >
        <span className="iw-thinking-mark">
          <img
            src="/marketing/assets/brand/igor-mark-black.svg"
            alt=""
            width="22"
            height="22"
          />
        </span>
        <span>{title}</span>
        <span className="iw-thinking-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      {message && !quiet && <p className="iw-working-detail">{message}</p>}
      <div className={`iw-reply-proof iw-proof-${format}`} aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="iw-proof-card" key={index}>
            <span className="iw-proof-image iw-skeleton" />
            <i className="iw-skeleton" />
          </div>
        ))}
      </div>
      {events.length > 0 && (
        <details className="iw-live-activity">
          <summary>
            Activity
            <ChevronDown />
          </summary>
          <ol>
            {events.map((item) => (
              <li key={item.activity.eventId}>
                <span
                  className="iw-event-state"
                  data-state={item.activity.actionStatus}
                  aria-label={item.activity.actionStatus}
                />
                <span>{item.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
