"use client";
import { readArtifactView, rememberArtifactView } from "./artifact-focus";
import { ProductText } from "./product-surfaces";
import { RevisionImpact } from "./revision-impact";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileText,
  History,
  Pencil,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Task, TaskAction } from "@/core/contracts";
import { morphLayout } from "./mobile-transitions";

type Document = NonNullable<Task["work"]>["documents"][number];

/** A task-bound projection of the existing connected-work contract.
 * No client-generated approvals, model code, or separate persistence.
 */
export function ConnectedWorkCanvas({
  task,
  busy,
  onTurn,
}: {
  task: Task;
  busy: boolean;
  onTurn: (action: TaskAction) => void;
}) {
  const work = task.work;
  const documents = work?.documents ?? [];
  const persistedId = task.conversationFocus?.activeArtifactId?.startsWith(
    "document:",
  )
    ? task.conversationFocus.activeArtifactId.slice("document:".length)
    : null;
  const [activeId, setActiveId] = useState<string | null>(persistedId);
  const selected =
    documents.find((item) => item.id === activeId) ??
    documents.find((item) => item.goalId === work?.activeGoalId) ??
    documents[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState("");
  const [boundId, setBoundId] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [revision, setRevision] = useState<string>("current");
  const [full, setFull] = useState(false);
  const [compareRevisions, setCompareRevisions] = useState(false);
  const dirty = draft !== base;
  const content = selected?.content ?? "";

  useEffect(() => {
    // Only view metadata is local. Evidence, approvals and content stay server-owned.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveId(
      readArtifactView(task)?.slice("document:".length) ?? persistedId,
    );
    // A new workspace or goal starts a new view; streamed revisions retain it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, work?.activeGoalId]);

  // Server snapshots may arrive after any turn, reload or direct mutation.
  // Never overwrite text the user is actively editing.
  useEffect(() => {
    if (!selected) {
      return;
    }

    if (boundId !== selected.id) {
      // Reconcile the authoritative artifact only when its identity changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBoundId(selected.id);
      setDraft(selected.content);
      setBase(selected.content);
      setVersion(selected.version);
      setEditing(false);
      setRevision("current");
    } else if (
      version !== selected.version &&
      (!dirty || selected.content === draft.trim())
    ) {
      // A successful server save changes the authoritative version. A failed
      // save does not: retain the local draft for a truthful retry.
      setDraft(selected.content);
      setBase(selected.content);
      setVersion(selected.version);
      setRevision("current");
    }
  }, [selected, boundId, dirty, draft, version]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!full) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFull(false);
      }
    };

    window.addEventListener("keydown", close);

    return () => window.removeEventListener("keydown", close);
  }, [full]);

  if (!work || !selected) {
    return null;
  }

  const historical =
    revision === "current"
      ? null
      : selected.history.find((r) => String(r.version) === revision);
  const display = historical?.content ?? (editing ? draft : content);
  const decisions = work.decisions.filter((d) => d.goalId === selected.goalId);
  const approved = decisions.filter(
    (decision) => decision.status === "approved",
  );
  const previous = selected.history.at(-1);
  // Source-linked project imagery only. The model cannot invent photo URLs.
  const relatedArtwork = task.candidates
    .filter(
      (candidate) =>
        candidate.freshness === "current" &&
        !candidate.sample &&
        Boolean(candidate.imageUrl) &&
        (candidate.id === task.canvas?.selectedCandidateId ||
          candidate.evidenceIds.some((id) =>
            selected.evidenceIds.includes(id),
          )),
    )
    .slice(0, 3);
  const send = (actions: Extract<TaskAction, { type: "work" }>["actions"]) =>
    onTurn({ type: "work", actions });

  const choose = (doc: Document) => {
    if (dirty || busy || doc.id === selected.id) {
      return;
    }

    morphLayout(() => setActiveId(doc.id));
    rememberArtifactView(task, `document:${doc.id}`);
  };

  return (
    <aside
      className={`ic-canvas ig-connected-work ${full ? "ic-fullscreen" : ""}`}
      style={{ viewTransitionName: "igor-task-canvas" }}
      data-workspace-id={task.id}
      data-active-artifact-id={`document:${selected.id}`}
      aria-label="Connected work"
      aria-busy={busy}
    >
      <header className="ic-canvas-header">
        <div>
          <h2>
            {work.goals.find((g) => g.id === selected.goalId)?.title ||
              "Your work"}
          </h2>
        </div>
        <button
          type="button"
          aria-label={full ? "Close expanded work" : "Expand connected work"}
          onClick={() => morphLayout(() => setFull(!full))}
        >
          {full ? <X /> : <FileText />}
        </button>
      </header>
      <div
        className="ig-connected-doc-tabs"
        role="group"
        aria-label="Connected documents"
      >
        {documents.map((doc) => (
          <button
            type="button"
            key={doc.id}
            disabled={dirty || busy}
            aria-pressed={doc.id === selected.id}
            onClick={() => choose(doc)}
          >
            {doc.title}
            {doc.edited && <Pencil aria-label="Edited by you" />}
          </button>
        ))}
      </div>
      {dirty && (
        <p className="ig-connected-warning" role="status">
          Save or discard your edits before switching documents.
        </p>
      )}
      <div className="ig-connected-document">
        <div className="ig-connected-document-bar">
          <span>
            <FileText />
            {selected.title}
          </span>
          <span>
            Version {selected.version}
            {selected.edited ? " · Edited by you" : " · Proposal"}
          </span>
        </div>
        {(selected.freshness === "stale" || selected.conflict) && (
          <p role="status" className="ig-connected-warning">
            {selected.conflict ||
              "An earlier decision changed. Review this document before approval."}
            Your existing wording is preserved.
          </p>
        )}
        <div className="ig-connected-tools">
          <label>
            <History />
            Revisions
            <select
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              aria-label="Document revision"
              disabled={dirty}
            >
              <option value="current">Current · v{selected.version}</option>
              {[...selected.history].reverse().map((v, index) => (
                <option value={String(v.version)} key={index}>
                  Version {v.version}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
          <button
            type="button"
            disabled={busy || revision !== "current"}
            aria-pressed={editing}
            onClick={() => morphLayout(() => setEditing(!editing))}
          >
            {editing ? "Preview" : "Edit document"}
          </button>
        </div>
        {!editing && !historical && (
          <section
            className="ig-work-showcase"
            aria-label="Saved work overview"
          >
            <div className="ig-work-showcase-intro">
              <span className="ig-work-overline">
                <span aria-hidden="true" className="ig-work-signal" />
                IGOR / CONNECTED WORK
              </span>
              <div className="ig-work-showcase-heading">
                <p className="ig-work-showcase-kicker">
                  {selected.status === "approved"
                    ? "APPROVED WORK"
                    : "WORKING PROPOSAL"}
                  {"  /  "} VERSION {selected.version}
                </p>
                <h3>{selected.title}</h3>
                <p className="ig-work-showcase-subtitle">
                  Your editable result, connected to decisions in this
                  conversation.
                </p>
              </div>
              <div className="ig-work-showcase-facts">
                {work.budget && (
                  <div>
                    <span>Confirmed budget</span>
                    <strong>
                      {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: work.budget.currency,
                        maximumFractionDigits: 0,
                      }).format(work.budget.amount)}
                    </strong>
                  </div>
                )}
                <div>
                  <span>Saved decisions</span>
                  <strong>{decisions.length}</strong>
                </div>
                <div>
                  <span>Approved decisions</span>
                  <strong>{approved.length}</strong>
                </div>
              </div>
            </div>
            {relatedArtwork.length > 0 && (
              <div
                className="ig-work-showcase-gallery"
                aria-label="Selected and source-linked project imagery"
              >
                {relatedArtwork.map((candidate, index) => (
                  <figure key={candidate.id} className="ig-work-showcase-tile">
                    <img
                      src={candidate.imageUrl!}
                      alt={candidate.name}
                      loading={index === 0 ? "eager" : "lazy"}
                    />
                    <figcaption>{candidate.name}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>
        )}
        {editing && !historical ? (
          <div className="ig-connected-edit">
            <label htmlFor={`ig-doc-${selected.id}`}>Document text</label>
            <textarea
              id={`ig-doc-${selected.id}`}
              aria-label={`Edit ${selected.title}`}
              maxLength={12000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="ig-connected-edit-actions">
              <button
                type="button"
                disabled={
                  !dirty || !draft.trim() || busy || selected.content !== base
                }
                onClick={() =>
                  send([
                    {
                      kind: "edit",
                      id: selected.id,
                      content: draft.trim(),
                    },
                  ])
                }
              >
                <Check /> {busy ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => {
                  setDraft(content);
                  setBase(content);
                }}
              >
                Discard changes
              </button>
            </div>
            {selected.content !== base && (
              <p role="alert">
                This document changed since you began editing. Copy your draft
                and review the latest version before saving.
              </p>
            )}
          </div>
        ) : (
          <div className="ig-connected-paper" aria-label="Document preview">
            <ProductText text={display} />
          </div>
        )}
        {!editing && !historical && !!work.critique?.issues.length && (
          <details
            className="ig-connected-warning"
            aria-label="Experience critique"
          >
            <summary>
              Review {work.critique.issues.length} issues and unknowns
            </summary>
            <ul>
              {work.critique.issues.map((issue) => (
                <li key={issue.id}>
                  <strong>
                    {issue.severity === "error"
                      ? "Needs correction"
                      : "Unverified"}
                    :{" "}
                  </strong>
                  {issue.message} {issue.action}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!editing && !historical && (
          <RevisionImpact task={task} document={selected} />
        )}
        {!editing && !historical && previous && (
          <section className="ig-work-version-review">
            <button
              type="button"
              aria-expanded={compareRevisions}
              aria-controls={`ig-work-versions-${selected.id}`}
              onClick={() => setCompareRevisions((open) => !open)}
            >
              <History aria-hidden="true" />
              {compareRevisions
                ? "Hide saved version comparison"
                : "Compare saved versions"}
              <ChevronDown aria-hidden="true" />
            </button>
            {compareRevisions && (
              <div
                id={`ig-work-versions-${selected.id}`}
                className="ig-work-version-pair"
                aria-label="Previous and current saved document versions"
              >
                <div>
                  <span>PREVIOUS / V{previous.version}</span>
                  <pre>{previous.content}</pre>
                </div>
                <div>
                  <span>CURRENT / V{selected.version}</span>
                  <pre>{selected.content}</pre>
                </div>
              </div>
            )}
          </section>
        )}
        {historical && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRevision("current");
              setEditing(true);
              setDraft(historical.content);
              setBase(content);
            }}
          >
            <ArrowLeft /> Restore as a new revision
          </button>
        )}
        <div className="ig-connected-approval">
          <span>
            <ShieldCheck />{" "}
            {selected.status === "approved"
              ? "Approved"
              : "Proposed · not yet approved"}
          </span>
          {selected.status !== "approved" && (
            <button
              type="button"
              disabled={
                busy ||
                dirty ||
                selected.freshness !== "current" ||
                Boolean(selected.conflict)
              }
              onClick={() => send([{ kind: "approve", id: selected.id }])}
            >
              Approve document
            </button>
          )}
        </div>
      </div>
      {decisions.length > 0 && (
        <section
          className="ig-connected-decisions"
          aria-label="Connected decisions"
        >
          <h3>Decisions connected to this work</h3>
          {decisions.map((decision) => (
            <article key={decision.id}>
              <div>
                <strong>{decision.title}</strong>
                <small>{decision.status}</small>
              </div>
              <p>{decision.value}</p>
              <details>
                <summary>
                  Why this was proposed <ChevronDown />
                </summary>
                <p>{decision.rationale}</p>
              </details>
              {decision.conflict && <p role="status">{decision.conflict}</p>}
              {decision.status === "proposed" && (
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => send([{ kind: "approve", id: decision.id }])}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => send([{ kind: "reject", id: decision.id }])}
                  >
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      <footer className="ic-canvas-footer">
        <Check /> Connected work saves in this conversation. No external actions
        are performed without a separate supported integration.
      </footer>
    </aside>
  );
}
