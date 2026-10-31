"use client";

import { ArrowRight, CalendarDays, FilePenLine, Plus, Sparkles } from "lucide-react";
import { ReferenceDocumentStage } from "./reference-document-stage";
import type { Task, TaskAction } from "@/core/contracts";

/**
 * This is a preview of task-owned work, not a mood board or a synthetic artifact.
 * Incomplete work must never look like a finished invitation or document.
 */
export function ReferenceCreateStage({task, busy, onTurn}: {
  task: Task;
  busy: boolean;
  onTurn: (action: TaskAction) => Promise<void>;
}) {
  const artifact = [...task.artifacts].reverse().find(item => item.freshness === "current");
  const selected = [...task.candidates, ...task.catalogue].filter(
    (candidate, index, items) =>
      task.brief.selected.includes(candidate.id) &&
      items.findIndex(other => other.id === candidate.id) === index &&
      !candidate.sample &&
      candidate.providerId &&
      (!("freshness" in candidate) || candidate.freshness === "current")
  );
  const images = selected.filter(candidate => Boolean(candidate.imageUrl)).slice(0, 4);
  const participants = task.brief.participants.filter(person => !person.sample);
  const isGathering = task.brief.kind === "gathering";
  const title = artifact?.title || "Create from this conversation";
  const shortTitle = title.length > 90 ? `${title.slice(0, 87).trimEnd()}…` : title;
  const hasEditableWork = !!task.work?.documents.length || !!task.artifacts.length || !!task.canvas;
  const edit = () => document.getElementById("ig-create-editor")?.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    block: "start",
  });
  const requestDraft = () => void onTurn({type:"message",
    text: isGathering
      ? "Create a real editable plan or invitation from this conversation. Use only confirmed choices and source-backed facts, label unresolved details, preserve all earlier work, and save the artifact."
      : "Create a real editable document from the work and evidence already in this conversation. Preserve sources and unresolved questions; save the artifact without inventing facts."
  });

  if (artifact && (artifact.kind === "research-report" ||
    (!isGathering && artifact.kind !== "invitation"))) {
    return <ReferenceDocumentStage task={task} onEdit={edit}/>;
  }

  return (
    <section className="ig-create-stage ig-create-stage-grounded" aria-label="Connected creation preview">
      <header className="ig-create-top">
        <div className="ig-create-heading-copy">
          <span className="ig-create-eyebrow">{artifact ? "Saved work · " + artifact.kind.replaceAll("-"," ") : "Your work · in progress"}</span>
          <h1>{shortTitle}</h1>
          <p>{artifact
            ? `Version ${artifact.version} · ${selected.length} selected ${selected.length === 1 ? "item" : "items"} · ${participants.length} people`
            : "No saved document or invitation is ready yet. Your conversation and its evidence remain available."}</p>
        </div>
        <div className="ig-create-top-actions">
          {hasEditableWork && <button type="button" onClick={edit}><FilePenLine size={18}/> Open work</button>}
          <button className="ig-create-invite" type="button" disabled={busy} onClick={requestDraft}>
            {artifact ? <Sparkles size={18}/> : <Plus size={18}/>}
            {artifact ? "Create another draft" : "Generate editable draft"}
          </button>
        </div>
      </header>
      {!artifact ? (
        <div className="ig-create-empty-state">
          <div className="ig-create-empty-main">
            <h2>Turn this conversation into something you can use.</h2>
            <p>{task.brief.goal || "Start with a question or describe what you want to create."}</p>
            <button type="button" disabled={busy} onClick={requestDraft}>
              Generate draft <ArrowRight size={18}/>
            </button>
          </div>
          <aside aria-label="Existing context">
            <h3>Available in this conversation</h3>
            <dl>
              <div><dt>Discoveries</dt><dd>{task.candidates.filter(c => !c.sample).length}</dd></div>
              <div><dt>Evidence records</dt><dd>{task.evidence.length}</dd></div>
              <div><dt>Selected options</dt><dd>{task.brief.selected.length}</dd></div>
              <div><dt>Open decisions</dt><dd>{task.brief.unresolved.length}</dd></div>
            </dl>
            <p>Generating a draft does not reserve anything or imply these decisions are final.</p>
          </aside>
        </div>
      ) : (
        <div className="ig-create-layout">
          <div className="ig-create-scene">
            {images.length ? (
              <div className="ig-create-collage ig-create-source-photos">
                {images.map((candidate,index) => (
                  <div key={candidate.id} className={`ig-create-photo ig-create-photo-${index+1}`}>
                    <img src={candidate.imageUrl!} alt={candidate.name} loading="lazy" referrerPolicy="no-referrer"/>
                    <div className="ig-create-poster-copy">
                      <strong>{candidate.name}</strong><span>{candidate.type.replaceAll("_"," ")}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <article className="ig-create-content-preview">
                <span>Saved {artifact.kind.replaceAll("-"," ")}</span>
                <h2>{shortTitle}</h2>
                <p>{artifact.content.slice(0,650) || "Open the editor to view your saved work."}</p>
              </article>
            )}
            {images.length > 0 && <div className="ig-create-caption">{artifact.content.slice(0,250).replace(/[#*]/g,"").trim()}</div>}
          </div>
          <aside className="ig-create-itinerary">
            <h2>{task.schedule.length ? "Planned stops" : "Connected work"}</h2>
            <div className="ig-create-itinerary-items">
              {task.schedule.length ? task.schedule.map((stop,index) => (
                <div key={index} className="ig-create-itinerary-item">
                  <span className="ig-create-item-icon">{index+1}</span>
                  <div><strong>{stop.label}</strong>
                    <span>{stop.candidateId ? selected.find(item=>item.id===stop.candidateId)?.name || "Option not verified" : "No linked option"}</span>
                    <small>{stop.minutes} minutes · Time not confirmed</small>
                  </div>
                </div>
              )) : <p>{selected.length ? selected.map(item=>item.name).join(" · ") : "No selections attached to this draft yet."}</p>}
            </div>
            <button type="button" onClick={edit}><FilePenLine size={18}/> Open saved editor</button>
          </aside>
        </div>
      )}
      {!!artifact && (
        <div className="ig-create-footer">
          <button type="button" disabled={busy} onClick={() => void onTurn({type:"message",text:"Add a useful section to the current artifact, preserving existing user-authored content and evidence."})}>
            <Plus size={18}/> Add section
          </button>
          <button type="button" disabled={busy} onClick={() => void onTurn({type:"message",text:"Refine the existing saved work selectively. List precisely what changed and what stayed unchanged."})}>
            <Sparkles size={18}/> Refine
          </button>
          {isGathering && <span className="ig-create-draft-status"><CalendarDays size={15}/> No reservation or invitation delivery implied</span>}
        </div>
      )}
    </section>
  );
}
