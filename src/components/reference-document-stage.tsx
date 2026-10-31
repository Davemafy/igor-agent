"use client";
import { ArrowDown, FilePenLine } from "lucide-react";
import type { Task } from "@/core/contracts";
import { ProductText } from "./product-surfaces";

/** The document stage is displayed ONLY after a real persisted artifact exists. */
export function ReferenceDocumentStage({task, onEdit}: {task: Task; onEdit: ()=>void}) {
  const artifact=[...task.artifacts].reverse().find(a => a.freshness === "current");
  if (!artifact) return null;

  const title=artifact.title.trim();
  const longTitle=title.length > 92;
  const displayTitle=longTitle ? artifact.kind.replaceAll("-"," ") : title;
  const evidence=[...(task.evidenceArchive || []),...task.evidence];
  const sources=artifact.evidenceIds
    .map(id=>evidence.find(e=>e.id===id))
    .filter((e):e is Task["evidence"][number]=>Boolean(e));
  const body=artifact.content.trim();
  return (
    <section className="ig-create-stage ig-create-stage-document" aria-label="Saved document">
      <header className="ig-create-document-heading">
        <div>
          <span className="ig-create-eyebrow">{artifact.kind.replaceAll("-"," ")} · Saved version {artifact.version}</span>
          <h1>{displayTitle}</h1>
          <p>Editable work from this conversation · {sources.length} linked {sources.length === 1 ? "source" : "sources"}</p>
        </div>
        <button type="button" className="ig-create-document-edit" onClick={onEdit}>
          <FilePenLine size={18}/> Open editor <ArrowDown size={16}/>
        </button>
      </header>
      <div className="ig-create-document-grid">
        <article className="ig-create-document-paper" aria-label="Saved document preview">
          <div className="ig-create-document-meta">
            <span>IGOR · {artifact.kind.replaceAll("-"," ")}</span>
            <span>v{artifact.version} · {artifact.locked ? "Locked" : "Editable"}</span>
          </div>
          <h2>{displayTitle}</h2>
          {longTitle && <p className="ig-create-original-request"><strong>Original saved title</strong> {title}</p>}
          {body ? (
            <div className="ig-create-document-excerpt"><ProductText text={body}/></div>
          ) : (
            <p className="ig-create-document-unfinished">This saved document has no body content yet. Open the editor to complete it.</p>
          )}
        </article>
        <aside className="ig-create-document-side">
          <h2>Evidence & versions</h2>
          <dl>
            <div><dt>Linked evidence</dt><dd>{sources.length}</dd></div>
            <div><dt>Saved versions</dt><dd>{task.artifactHistory?.length || 0}</dd></div>
            <div><dt>Open decisions</dt><dd>{task.brief.unresolved.length}</dd></div>
          </dl>
          <h3>{sources.length ? "Attached sources" : "Sources not attached"}</h3>
          {sources.length ? sources.map(source=>(
            <div key={source.id} className="ig-create-document-source">
              <strong>{source.title || "Evidence record"}</strong>
              <small>{source.delivery || source.source} · {source.freshness}</small>
              {source.limitations.length > 0 && <small>{source.limitations.join("; ")}</small>}
            </div>
          )) : <p>No source records are linked to this document. This is not a verified research report.</p>}
          <button type="button" className="ig-create-document-edit" onClick={onEdit}>
            Edit saved document <ArrowDown size={16}/>
          </button>
        </aside>
      </div>
    </section>
  );
}
