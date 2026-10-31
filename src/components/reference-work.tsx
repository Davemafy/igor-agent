"use client";

import { useMemo, useState } from "react";
import type { Task, TaskAction } from "@/core/contracts";
import { adaptTaskForPresentation, type WorkspaceCandidate, type WorkspaceViewModel } from "./workspace-view-model";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Heart, Plus, Search } from "lucide-react";
import { TaskCanvas } from "./task-canvas";
import IgorSpatialCanvas from "./igor-spatial-canvas";
import { GroundedMap } from "./grounded-map";

/**
 * These are alternate presentations of the *same* canonical task. They neither
 * fabricate cultural evidence nor maintain a second persisted workspace.
 */
type View = "discover" | "compare" | "plan" | "detail" | "revisions" | "maps";
type Props = {
  task: Task;
  view: View;
  busy: boolean;
  onTurn: (action: TaskAction) => Promise<void>;
  onNavigate: (view: View) => void;
  selectedCandidateId?: string | null;
  onSelectCandidate?: (id: string | null) => void;
};
type Candidate = WorkspaceCandidate;

const typeLabel = (value: string) => value.replaceAll("_", " ");
const fact = (value: number | null) =>
  value == null ? "Not checked" : Number.isFinite(value) ? String(value) : "Not checked";

function CandidateMedia({ candidate, wide = false }: { candidate: Candidate; wide?: boolean }) {
  const [broken, setBroken] = useState(false);

  return (
    <div className={`ir-media ${wide ? "ir-media-wide" : ""}`}>
      {candidate.imageUrl && !broken ? (
        <img src={candidate.imageUrl} alt={candidate.name} loading="lazy"
          referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <div className="ir-media-fallback" role="img" aria-label={`No verified image for ${candidate.name}`}>
          <span>{typeLabel(candidate.type)}</span>
          <strong>{candidate.name}</strong>
        </div>
      )}
    </div>
  );
}

function EvidenceSource({ source }: { source: Task["evidence"][number] }) {
  const url = source.reference.startsWith("https://") && source.source === "provider-returned" ? source.reference : null;

  return (
    <article className="ir-evidence" key={source.id}>
      <div className="ir-source-head">
        <strong>{source.title || (source.kind === "cultural" ? "Qloo cultural evidence" : "Source record")}</strong>
        <span>{source.delivery || source.source} · {source.freshness}</span>
      </div>
      <p>{source.summary}</p>
      <small>Retrieved {Number.isFinite(Date.parse(source.at)) ? new Date(source.at).toLocaleDateString() : "date unknown"}</small>
      {source.explanation && <p>{source.explanation}</p>}
      {!!source.limitations.length && <p className="ir-subtle">{source.limitations.join(" · ")}</p>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Open source <ArrowRight size={15} /></a>}
    </article>
  );
}

function CandidateSignals({ task, candidate, vm }: { task: Task; candidate: Candidate; vm: WorkspaceViewModel }) {
  const signals = vm.culturalSignalsForCandidate(candidate.id);
  const sampleIds = new Set(task.brief.participants.filter((p) => p.sample).map((p) => p.id));

  return (
    <div className="ir-signals">
      {!signals.length && <p className="ir-subtle">No Qloo cultural signal returned for this candidate.</p>}
      {signals.map((signal) => (
        <div className="ir-signal" key={signal.key + ":" + signal.queryId}>
          <div className="ir-signal-top">
            <strong>{signal.participantName ? `${sampleIds.has(signal.participantId || "") ? "Illustrative profile · " : ""}${signal.participantName}` : (signal.scope === "context" ? "Context query" : "Unattributed query")}</strong>
            <span>{signal.delivery}</span>
          </div>
          <p>Rank #{signal.rankWithinQuery} <span>within query {signal.queryId}</span></p>
          <p>Raw affinity {signal.rawAffinity == null ? "not returned" : signal.rawAffinity}</p>
          <small>Seeds: {signal.seedIds.length ? signal.seedIds.join(", ") : "Not supplied"}</small>
          <small>{signal.explanationScope === "recommendation"
            ? "Per-result contributors"
            : signal.explanationScope === "aggregate-query" ? "Aggregate-query contributors, not a personal explanation"
              : "No per-result explanation returned"} · {signal.retrievedAt}</small>
        </div>
      ))}
    </div>
  );
}

export function ReferenceWork({ task, view, busy, onTurn, onNavigate, selectedCandidateId, onSelectCandidate }: Props) {
  const vm = useMemo(() => adaptTaskForPresentation(task), [task]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [compareCategory, setCompareCategory] = useState("all");
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = selectedCandidateId ?? localSelectedId;

  function setSelectedId(id: string | null) {
    setLocalSelectedId(id);
    onSelectCandidate?.(id);
  }

  const [comparisonIds, setComparisonIds] = useState<string[]>([]);
  const [comparisonEdited, setComparisonEdited] = useState(false);
  const [planTab, setPlanTab] = useState<"overview" | "itinerary" | "map" | "options" | "notes">("overview");
  const [advancedMap, setAdvancedMap] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "why" | "sources">("why");
  const candidates = vm.candidates.filter((c) => !c.sample && (!("freshness" in c) || c.freshness === "current"));
  const categories = ["all", "places", "films", "music", "books", "dining", "experiences", "ideas"];
  const matchesCategory = (candidate: Candidate) => category === "all" ||
    (category === "films" && (candidate.type === "movie" || candidate.type === "tv_show")) ||
    (category === "music" && candidate.type === "artist") ||
    (category === "books" && candidate.type === "book") ||
    (category === "places" && candidate.type === "place") ||
    candidate.tags.some((tag) => tag.toLocaleLowerCase() === category);
  const matchesCompareCategory = (candidate: Candidate) =>
    compareCategory === "all" ||
    (compareCategory === "films" && (candidate.type === "movie" || candidate.type === "tv_show")) ||
    (compareCategory === "music" && candidate.type === "artist") ||
    candidate.tags.some((tag) => tag.toLowerCase() === compareCategory);
  const filtered = candidates.filter((c) =>
    matchesCategory(c) &&
    [c.name, c.description, ...c.tags].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  const emptyDiscovery = candidates.length === 0;
  const needsMusic = /music|artist|band|concert|jazz|playlist/i.test(task.brief.goal) &&
    !candidates.some(candidate => candidate.type === "artist");
  const needsFilms = /film|movie|cinema|tv|screening/i.test(task.brief.goal) &&
    !candidates.some(candidate => candidate.type === "movie" || candidate.type === "tv_show");

  const chosen = (selectedId && vm.candidateById.get(selectedId)) || filtered[0] || candidates[0];
  const originalComparisonIds = task.canvas?.comparisonIds.length
    ? task.canvas.comparisonIds : task.brief.selected.length ? task.brief.selected : candidates.slice(0, 4).map((c) => c.id);
  const comparedIds = comparisonEdited ? comparisonIds : originalComparisonIds.slice(0, 4);
  const compared = comparedIds.map((id) => vm.candidateById.get(id)).filter((c): c is Candidate => !!c);
  const proposalNode = task.canvas?.surface.nodes.find((node) => node.type === "discovery" || node.type === "spatial");

  async function addToWork(id: string) {
    const canEditItinerary = !!proposalNode && !!task.canvas &&
      ("candidateIds" in proposalNode) && proposalNode.candidateIds.includes(id) &&
      task.candidates.some((candidate) => candidate.id === id && candidate.freshness === "current");

    if (canEditItinerary && task.canvas && proposalNode) {
      const candidateIds = [...new Set([...task.canvas.itineraryIds, id])];
      await onTurn({ type: "canvas", surfaceId: task.canvas.surface.id,
        mutation: { operation: "itinerary", nodeId: proposalNode.id, candidateIds } });
    } else {
      // A canvas 'select' only changes visual focus: it does NOT add to a plan.
      // Route unsupported structural changes through the authoritative engine.
      await onTurn({ type: "message", text: `Add the existing candidate with ID ${id} to my current work. Preserve unrelated selections and return the updated work.` });
    }
  }

  function toggleCompare(id: string) {
    const current = comparisonEdited ? comparisonIds : originalComparisonIds.slice(0, 4);
    setComparisonIds(current.includes(id)
      ? current.filter((entry) => entry !== id)
      : current.length >= 4 ? current : [...current, id]);
    setComparisonEdited(true);
  }
  // A spatial renderer is a presentation of verified Task coordinates, not an
  // engine state transition. Some valid tasks have geocoded candidates but
  // no spatial presentation node. Those tasks still deserve a real map.

  const spatialNode = task.canvas?.surface.nodes.find((node) => node.type === "spatial");
  const verifiedMap = vm.mapPlaces.length > 0 ? (
    <IgorSpatialCanvas
      task={task}
      node={{
        id: "igor:verified-candidate-map",
        type: "spatial",
        candidateIds: vm.mapPlaces.slice(0, 30).map(({candidate}) => candidate.id),
      }}
      busy={busy}
      selectedCandidateId={selectedId}
      mutate={(mutation) => {
        if (mutation.operation === "select") {
          setSelectedId(mutation.candidateId);

          return;
        }

        if (mutation.operation === "itinerary") {
          void onTurn({type:"message", text:
            "Update my existing plan with these exact verified place IDs in order: " +
            mutation.candidateIds.join(", ") +
            ". Preserve all unrelated work and confirm only after saving."});
        }
      }}
    />
  ) : null;
  const heading = view === "discover" ? "Explore" : view === "compare" ? "Compare" :
    view === "plan" ? task.brief.goal || "Connected work" :
      view === "maps" ? "Places in context" : view === "revisions" ? "Changes & versions" : chosen?.name || "Details";
  const subtitle = view === "discover" ? "Discover what your work has actually found." :
    view === "compare" ? "Evidence side by side, without invented compatibility scores." :
      view === "plan" ? "One connected outcome, with its constraints and open decisions." :
        view === "maps" ? "Only provider-grounded places appear on the map." :
          view === "revisions" ? "Every change linked to the saved task revision." : "Source details and limitations";

  return (
    <section className={`ir-surface ir-${view}`} aria-label={heading}>
      {task.mode === "illustrative-fixtures" && <p className="ir-demo-note" role="status">Illustrative development data · not live Qloo or verified availability</p>}
      <header className="ir-heading">
        <div><h2>{heading}</h2><p>{subtitle}</p></div>
        {view === "detail" && <button className="ir-secondary" onClick={() => onNavigate("discover")}><ArrowLeft size={17} /> Back to explore</button>}
      </header>

      {view === "discover" && (
        <div className="ir-discover-workspace">
          <form className="ir-search" onSubmit={(event) => {
            event.preventDefault();
            const text = query.trim();

            if (text) {
              void onTurn({ type: "message", text: `Explore ${text}. Find relevant results with sources and explain what is known.` });
            }
          }}>
            <Search size={21} aria-hidden="true" />
            <label className="ir-sr" htmlFor="ir-discovery-search">Discover across any domain</label>
            <input id="ir-discovery-search" type="search" placeholder="Discover something…" value={query}
              onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="ir-search-submit" disabled={!query.trim() || busy} aria-label="Ask Igor to discover"><ArrowRight size={23} /></button>
          </form>
          <div className="ir-chip-row" role="group" aria-label="Discovery categories">
            {categories.map((cat) => <button key={cat} aria-pressed={category === cat}
              onClick={() => setCategory(cat)}>{cat === "all" ? "All" : cat === "films" ? "Films & TV" : cat[0].toUpperCase() + cat.slice(1)}</button>)}
          </div>

          {emptyDiscovery && (
            <section className="ir-discovery-start" aria-label="Start a source-backed discovery">
              <header>
                <h3>Start exploring.</h3>
                <p>Ask a question or choose a direction. Results will appear here when Igor returns them.</p>
              </header>
              <div className="ir-discovery-start-links">
                {([
                  {category:"films",label:"Find a film",prompt:"Discover films or series that match my taste. Show source-linked reasons and ask for any essential preferences."},
                  {category:"music",label:"Explore music",prompt:"Discover artists, music and meaningful cultural connections using actual Qloo evidence."},
                  {category:"places",label:"Find places",prompt:"Help me find real places for my goal; ask which city and verify locations."},
                  {category:"ideas",label:"Research an idea",prompt:"Help me research an idea, compare reliable evidence and create an editable result."},
                  {category:"books",label:"Find a book",prompt:"Recommend books with actual source information, explaining relevance without invented affinity."},
                  {category:"dining",label:"Explore dining",prompt:"Help me find restaurants that fit my preferences. Ask the location and distinguish verified facts from unknown availability."},
                  {category:"experiences",label:"Find experiences",prompt:"Discover real cultural experiences based on my interests and chosen location."},
                ] as const).filter(item=>
                  (category === "all" ? ["films","music","places","ideas"].includes(item.category) : item.category === category) &&
                  (!query.trim() || item.label.toLowerCase().includes(query.trim().toLowerCase()))
                ).map(item=>(
                  <button type="button" key={item.label} disabled={busy}
                    onClick={()=>item.category === "places" ? onNavigate("maps") : void onTurn({type:"message",text:item.prompt})}>
                    <span>{item.label}</span><ArrowRight size={17} aria-hidden="true"/>
                  </button>
                ))}
              </div>
              <p className="ir-discovery-no-results">No recommendations have been returned for this task yet. These are actions, not recommended results.</p>
            </section>
          )}
          {!emptyDiscovery && (
            <>
              <div className="ir-section-line"><h3>Discovered for this task</h3>
                <span>{filtered.length} grounded {filtered.length === 1 ? "result" : "results"}</span></div>
              <div className="ir-result-domain-note" aria-label="Current result coverage">
                <span>{candidates.filter(c=>c.type==="movie"||c.type==="tv_show").length} film/TV</span>
                <span>{candidates.filter(c=>c.type==="artist").length} music</span>
                <span>{vm.evidenceById.size} evidence records</span>
                {(needsMusic || needsFilms) && <button type="button" disabled={busy} onClick={()=>void onTurn({type:"message",text:
                  needsMusic ? "Continue this same task and discover Qloo-backed music artists or live music options that match the existing film and group preferences. Keep current film discoveries unchanged. Show source evidence and query-scoped reasoning." :
                    "Continue this same task with Qloo-backed film and TV recommendations. Preserve the already-found music and demonstrate source-linked reasons."
                })}>Find missing {needsMusic ? "music" : "film"} options <ArrowRight size={15}/></button>}
              </div>
              <div className="ir-gallery">
                {filtered.map((c) => (
                  <article key={c.id} className="ir-candidate">
                    <button className="ir-card-open" onClick={() => {setSelectedId(c.id); onNavigate("detail");}}>
                      <CandidateMedia candidate={c} /><strong>{c.name}</strong><span>{typeLabel(c.type)}</span>
                    </button>
                    <div className="ir-card-proof" aria-label={`Evidence for ${c.name}`}>
                      {vm.culturalSignalsForCandidate(c.id).slice(0,1).map(signal=>(
                        <div key={signal.key+signal.queryId} className="ir-card-signal">
                          <span className="ir-card-proof-source">Qloo · {signal.delivery}</span>
                          <strong>Rank #{signal.rankWithinQuery}</strong>
                          <small>{signal.participantName ? `For ${signal.participantName}` : "Context query"} · raw affinity {signal.rawAffinity ?? "not supplied"}</small>
                          {!!signal.seedIds.length && <small>Seed IDs: {signal.seedIds.slice(0,3).join(", ")}</small>}
                        </div>
                      ))}
                      {!vm.culturalSignalsForCandidate(c.id).length && (
                        <small>{vm.evidenceForCandidate(c.id).length
                          ? `${vm.evidenceForCandidate(c.id).length} attached source ${vm.evidenceForCandidate(c.id).length === 1 ? "record" : "records"}`
                          : "No Qloo affinity returned"}</small>
                      )}
                    </div>
                    <div className="ir-card-actions">
                      <button disabled={busy} onClick={() => void addToWork(c.id)}><Plus size={15}/> Add to work</button>
                      <button onClick={() => {toggleCompare(c.id); onNavigate("compare");}}>Compare</button>
                    </div>
                  </article>
                ))}
              </div>
              {!filtered.length && <div className="ir-empty" role="status"><h3>No matching saved results</h3>
                <p>Try another category, or search for something new.</p>
                <button onClick={() => {setQuery("");setCategory("all");}}>Clear filters</button></div>}
            </>
          )}
        </div>
      )}

      {view === "compare" && (
        <div className="ir-comparison-workspace">
          <div className="ir-comparison-toolbar">
            <div className="ir-compare-domains" role="group" aria-label="Comparison category">
              {["all", "films", "music", "dining", "experiences"].map((tab) => (
                <button key={tab} aria-pressed={compareCategory === tab} onClick={() => setCompareCategory(tab)}>
                  {tab === "all" ? "All" : tab === "films" ? "Films" : tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <button className="ir-clear-comparison" onClick={() => {setComparisonIds([]);setComparisonEdited(true);}}>
              Clear all
            </button>
          </div>
          <div className="ir-compare-picker" role="group" aria-label="Choose candidates to compare">
            {candidates.filter(matchesCompareCategory).map((candidate) => (
              <button key={candidate.id} aria-pressed={comparedIds.includes(candidate.id)}
                onClick={() => toggleCompare(candidate.id)}>
                {comparedIds.includes(candidate.id) ? <Check size={14}/> : <Plus size={14}/>}
                {candidate.name}
              </button>
            ))}
          </div>
          {compared.length ? (
            <div className="ir-matrix-scroll" tabIndex={0} aria-label="Scrollable side by side comparison">
              <div className="ir-matrix" style={{gridTemplateColumns: `repeat(${compared.length}, minmax(240px, 1fr))`}}>
                {compared.map((candidate) => {
                  const signals = vm.culturalSignalsForCandidate(candidate.id);
                  const participants = task.brief.participants.filter((person) => !person.sample || task.mode === "illustrative-fixtures");

                  return (
                    <article className="ir-matrix-column" key={candidate.id}>
                      <button className="ir-comparison-cover" onClick={() => {setSelectedId(candidate.id);onNavigate("detail");}}
                        aria-label={`Open details for ${candidate.name}`}>
                        <CandidateMedia candidate={candidate} wide />
                        <strong>{candidate.name}</strong>
                      </button>
                      <div className="ir-comparison-people">
                        {participants.length ? participants.map((person) => {
                          const signal = signals.find((entry) => entry.participantId === person.id);

                          return (
                            <div className="ir-comparison-person" key={person.id}>
                              <span className="ir-person-avatar" aria-hidden="true">{person.name.slice(0,1).toUpperCase()}</span>
                              <div className="ir-person-signal">
                                <div className="ir-person-topline">
                                  <strong>{person.name}</strong>
                                  <span>{signal ? `Rank #${signal.rankWithinQuery} · ${signal.rawAffinity ?? "—"}` : "Not scored"}</span>
                                </div>
                                <small>{signal ? `Qloo ${signal.delivery} · query ${signal.queryId} · seed IDs: ${signal.seedIds.join(", ") || "not supplied"}` :
                                  person.preferences.filter((pref) => pref.confirmed).slice(0,2).map((pref) => pref.value).join(" · ") || "No comparable taste signal"}</small>
                              </div>
                            </div>
                          );
                        }) : (
                          <div className="ir-compare-no-people">
                            <strong>{signals.length ? "Contextual Qloo evidence" : "Personal taste signals unavailable"}</strong>
                            {signals.length ? signals.slice(0,3).map(signal=>(
                              <div className="ir-compare-context-signal" key={signal.key+signal.queryId}>
                                <span>Qloo {signal.delivery} · Rank #{signal.rankWithinQuery}</span>
                                <small>Raw affinity {signal.rawAffinity ?? "not supplied"} · Query {signal.queryId}</small>
                                <small>Seed IDs: {signal.seedIds.join(", ") || "not supplied"}</small>
                              </div>
                            )) : <p>No per-person scores were returned. Igor will not invent people or affinity scores.</p>}
                          </div>
                        )}
                      </div>
                      <div className="ir-compare-practical">
                        <p><span>Duration</span><strong>{candidate.duration.value == null ? "Unknown" : candidate.duration.value + " min"}</strong></p>
                        <p><span>Cost</span><strong>{candidate.cost.value == null ? "Unknown" : candidate.cost.value + " " + task.brief.constraints.currency}</strong></p>
                        <p><span>Availability</span><strong>{candidate.available == null ? "Not checked" : candidate.available ? "Reported available" : "Reported unavailable"}</strong></p>
                      </div>
                      <button className="ir-compare-add" disabled={busy} onClick={() => void addToWork(candidate.id)}>
                        <Plus size={21}/> Add to plan
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : <div className="ir-empty"><h3>No options selected</h3><p>Select candidates above, or discover some first.</p><button type="button" onClick={() => onNavigate("discover")}>Explore candidates</button></div>}
          <p className="ir-footnote">Qloo ranks and raw affinity values belong to individual queries. Missing or incomparable values are never manufactured or averaged.</p>
        </div>
      )}

      {view === "detail" && (chosen ? (
        <div className="ir-entity-detail">
          <div className="ir-detail-hero">
            {chosen.imageUrl ? <img src={chosen.imageUrl} alt="" /> : (
              <div className="ir-detail-hero-fallback" aria-hidden="true">
                <span>{typeLabel(chosen.type)}</span>
              </div>
            )}
            <div className="ir-detail-hero-content">
              <h2>{chosen.name}</h2>
              <p>{typeLabel(chosen.type)}{chosen.duration.value != null ? ` · ${chosen.duration.value} min` : ""}</p>
              {vm.culturalSignalsForCandidate(chosen.id).length > 0 && (
                <div className="ir-detail-signal-summary" aria-label="Qloo recommendation evidence">
                  {vm.culturalSignalsForCandidate(chosen.id).slice(0,2).map(signal=>(
                    <span key={signal.key+signal.queryId}>
                      Qloo {signal.delivery} · Rank #{signal.rankWithinQuery} · {signal.participantName || "Context"} · raw affinity {signal.rawAffinity ?? "not returned"}
                    </span>
                  ))}
                </div>
              )}
              <div className="ir-detail-action-bar">
                <button className="ir-detail-add" disabled={busy} onClick={() => void addToWork(chosen.id)}>
                  <Plus size={20}/> Add to plan
                </button>
                <button disabled={busy} onClick={() => {toggleCompare(chosen.id);onNavigate("compare");}}>Compare</button>
                <button disabled={busy} onClick={() => void onTurn({type:"message",
                  text:`Save the candidate with canonical ID ${chosen.id} in my work. Keep all existing selections intact.`})}>
                  <Heart size={18}/> Ask to save
                </button>
              </div>
            </div>
          </div>
          <div className="ir-detail-tabs" role="group" aria-label="Detail sections">
            <button aria-pressed={detailTab==="overview"} onClick={() => setDetailTab("overview")}>Overview</button>
            <button aria-pressed={detailTab==="why"} onClick={() => setDetailTab("why")}>Why this?</button>
            <button aria-pressed={detailTab==="sources"} onClick={() => setDetailTab("sources")}>Sources</button>
          </div>
          <section className="ir-detail-evidence-panel">
            {detailTab==="overview" && (
              <div className="ir-detail-section">
                <h3>Overview</h3>
                <p>{chosen.description || "No reliable description is attached to this entity yet."}</p>
                <div className="ir-detail-facts">
                  <p>Availability <strong>{chosen.available == null ? "Not checked" : chosen.available ? "Reported available" : "Reported unavailable"}</strong></p>
                  <p>Duration <strong>{chosen.duration.value == null ? "Unknown" : chosen.duration.value + " minutes"}</strong></p>
                  <p>Cost <strong>{chosen.cost.value == null ? "Unknown" : chosen.cost.value + " " + task.brief.constraints.currency}</strong></p>
                </div>
              </div>
            )}
            {detailTab==="why" && (
              <div className="ir-detail-section">
                <h3>Why this fits</h3>
                <p>These are the actual query-scoped Qloo signals recorded for this candidate. Missing signals are not inferred.</p>
                <CandidateSignals task={task} candidate={chosen} vm={vm}/>
              </div>
            )}
            {detailTab==="sources" && (
              <div className="ir-detail-section">
                <h3>Qloo evidence</h3>
                <div className="ir-qloo-summary">
                  {vm.culturalSignalsForCandidate(chosen.id).length ? vm.culturalSignalsForCandidate(chosen.id).map((signal) => (
                    <div className="ir-qloo-signal" key={signal.key+signal.queryId}>
                      <div><small>Rank within query</small><strong>#{signal.rankWithinQuery}</strong><span>Query {signal.queryId}</span></div>
                      <div><small>Affinity</small><strong>{signal.rawAffinity ?? "—"}</strong><span>Raw Qloo value</span></div>
                      <div><small>Scope and contributors</small>
                        <p>{signal.scope === "participant" ? signal.participantName : "Context-only signal"}</p>
                        <span>{signal.explanationScope === "aggregate-query" ? "Aggregate contributors, not a per-result explanation" :
                          signal.contributorIds.length ? signal.contributorIds.join(", ") : "No contributors returned"}</span></div>
                    </div>
                  )) : <p className="ir-subtle">No Qloo affinity result was returned for this entity.</p>}
                </div>
                <h3>Source details</h3>
                <div className="ir-source-detail-grid">
                  {vm.evidenceForCandidate(chosen.id).length ? (
                    vm.evidenceForCandidate(chosen.id).map((source) => <EvidenceSource key={source.id} source={source}/>)
                  ) : <p className="ir-subtle">No inspectable source records are attached to this candidate.</p>}
                </div>
                <p className="ir-footnote">Qloo data is a contextual input; Igor&apos;s interpretation and third-party facts are not automatically provider-certified.</p>
              </div>
            )}
          </section>
        </div>
      ) : <div className="ir-empty"><h3>No candidate selected</h3><p>Discover a grounded result to inspect its details and evidence.</p><button type="button" onClick={() => onNavigate("discover")}>Explore results</button></div>)}

      {view === "plan" && (
        <div className="ir-connected-plan">
          <div className="ir-plan-byline">
            <span>{task.brief.participants.filter((person) => !person.sample).length || "No confirmed"} people</span>
            <span>{task.brief.constraints.location || "Location TBD"}</span>
            <span>Saved revision {vm.revision}</span>
          </div>
          <div className="ir-plan-tabs" role="group" aria-label="Plan sections">
            {(["overview", "itinerary", "map", "options", "notes"] as const).map((tab) => (
              <button key={tab} aria-pressed={planTab === tab}
                onClick={() => setPlanTab(tab)}>
                {tab[0].toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          {(planTab === "overview" || planTab === "itinerary") && (
            <div className="ir-plan-reference-grid">
              <div className="ir-plan-timeline-pane">
                {task.schedule.length ? (
                  <ol className="ir-plan-timeline">
                    {task.schedule.map((stop, index) => {
                      const candidate = stop.candidateId ? vm.candidateById.get(stop.candidateId) : null;

                      return (
                        <li key={index}>
                          <span className="ir-plan-time">Time TBD</span>
                          <span className="ir-plan-marker" aria-hidden="true" />
                          <button className="ir-plan-event" disabled={!candidate}
                            onClick={() => { if (candidate) {setSelectedId(candidate.id);onNavigate("detail");} }}>
                            <div className="ir-plan-thumb">
                              {candidate?.imageUrl ? <img src={candidate.imageUrl} alt="" /> : <span>{index + 1}</span>}
                            </div>
                            <div>
                              <strong>{stop.label}</strong>
                              <span>{candidate?.name || "Details not confirmed"}</span>
                              <small>{stop.minutes} min{candidate?.available == null ? " · Availability not checked" : ""}</small>
                              {task.brief.participants.some((person) => !person.sample) && (
                                <div className="ir-plan-avatars" aria-label="Plan participants">
                                  {task.brief.participants.filter((person) => !person.sample).slice(0,6).map((person) => (
                                    <i key={person.id} title={person.name}>{person.name.slice(0,1)}</i>
                                  ))}
                                </div>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="ir-plan-no-schedule">
                    <h3>Your work is connected.</h3>
                    <p>No fixed itinerary exists for this task. The outcomes and selected evidence remain available.</p>
                    <div className="ir-selection-list">{vm.selectedCandidates.map((candidate) => (
                      <button key={candidate.id} onClick={() => {setSelectedId(candidate.id);onNavigate("detail");}}>
                        {candidate.name}<ArrowRight size={17}/>
                      </button>
                    ))}</div>
                  </div>
                )}
                <button className="ir-plan-add-stop" disabled={busy} onClick={() =>
                  void onTurn({ type: "message", text: "Add a suitable next step to my existing plan, preserving all confirmed decisions. Ask only for any essential details." })
                }><Plus size={22}/> Add a stop</button>
              </div>
              <aside className="ir-plan-cover">
                <div className="ir-plan-cover-art">
                  {vm.selectedCandidates[0]?.imageUrl ? (
                    <img src={vm.selectedCandidates[0].imageUrl} alt="Selected work cover" />
                  ) : (
                    <div className="ir-plan-cover-placeholder" role="img" aria-label="No verified cover image available">
                      <span>Connected plan</span>
                      <strong>{task.brief.goal || "Your work"}</strong>
                    </div>
                  )}
                  <div className="ir-plan-cover-copy">
                    <strong>{task.brief.goal || "An experience worth remembering."}</strong>
                  </div>
                </div>
              </aside>
            </div>
          )}
          {planTab === "map" && (
            <div className="ir-plan-tab-panel">
              {spatialNode ? (
                <TaskCanvas task={task} busy={busy} onTurn={onTurn} focusNodeId={spatialNode.id}/>
              ) : verifiedMap || (
                <div className="ir-empty">A map becomes available when Igor has verified coordinates for the places in your plan.</div>
              )}
            </div>
          )}
          {planTab === "options" && (
            <div className="ir-plan-tab-panel">
              <h3>Options you considered</h3>
              <div className="ir-selection-list">
                {vm.candidates.filter((candidate) => !candidate.sample).map((candidate) => (
                  <button key={candidate.id} onClick={() => {setSelectedId(candidate.id);onNavigate("detail");}}>
                    {candidate.name}<ArrowRight size={17}/>
                  </button>
                ))}
              </div>
              <button className="ir-secondary" onClick={() => onNavigate("compare")}>Compare alternatives</button>
            </div>
          )}
          {planTab === "notes" && (
            <div className="ir-plan-tab-panel ir-plan-notes">
              <h3>Current constraints</h3>
              <p>Location: <strong>{task.brief.constraints.location}</strong></p>
              <p>Budget: <strong>{task.brief.constraints.budget} {task.brief.constraints.currency}</strong></p>
              <p>Duration: <strong>{task.brief.constraints.duration} minutes</strong></p>
              {task.brief.unresolved.length ? (
                <><h3>Still unresolved</h3>{task.brief.unresolved.map((text, index) => <p key={index}>{text}</p>)}</>
              ) : <p>No unresolved constraints recorded.</p>}
              <button className="ir-secondary" onClick={() => onNavigate("revisions")}>View version history <ArrowRight size={17}/></button>
            </div>
          )}
        </div>
      )}

      {view === "revisions" && (
        <div className="ir-revision-surface">
          <div className="ir-revision-summary">
            <div className="ir-revision-speaker" aria-hidden="true">
              <img src="/marketing/assets/brand/igor-mark-white.svg" alt="" />
            </div>
            <div className="ir-revision-message">
              <p>Review the changes in your connected work. Only server-confirmed edits and versions appear below.</p>
              <small>Current saved revision · v{vm.revision}</small>
            </div>
          </div>
          <div className="ir-revision-section">
            <h3>Changes</h3>
            {(task.receipts || []).length ? (
              <div className="ir-revision-checks">
                {[...(task.receipts || [])].reverse().slice(0,1).flatMap((receipt) =>
                  receipt.changed.length ? receipt.changed : ["No item-level differences recorded"]
                ).map((changed,index) => (
                  <div key={changed + ":" + index}>
                    <Check size={21} aria-hidden="true" />
                    <span>{changed}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ir-revision-no-change">No previous confirmed revision changes are recorded for this task.</p>
            )}
          </div>
          <div className="ir-revision-section">
            <h3>Updated work</h3>
            <div className="ir-revision-previews">
              {vm.selectedCandidates.filter((candidate) => !candidate.sample).slice(0,5).map((candidate) => (
                <button key={candidate.id} onClick={() => {setSelectedId(candidate.id);onNavigate("detail");}}>
                  <CandidateMedia candidate={candidate} wide />
                  <span>{candidate.name}</span>
                </button>
              ))}
              {!vm.selectedCandidates.length && task.artifacts.length ? (
                task.artifacts.slice(-4).map((artifact) => (
                  <article key={artifact.id} className="ir-revision-artifact-preview">
                    <strong>{artifact.title}</strong>
                    <span>{artifact.kind.replaceAll("-"," ")}</span>
                  </article>
                ))
              ) : null}
              {!vm.selectedCandidates.length && !task.artifacts.length ? (
                <p className="ir-subtle">No saved artifact preview is available yet.</p>
              ) : null}
            </div>
          </div>
          <div className="ir-revision-section">
            <h3>Version history</h3>
            <ol className="ir-revision-history">
              {[...(task.receipts || [])].reverse().map((receipt,index) => (
                <li key={receipt.inputHash + ":" + index}>
                  <span className="ir-version-number">v{receipt.toVersion}</span>
                  <div>
                    <time dateTime={receipt.at}>{Number.isFinite(Date.parse(receipt.at)) ?
                      new Date(receipt.at).toLocaleString() : "Time not recorded"}</time>
                    <p>{receipt.changed.length ? receipt.changed.join(" · ") : receipt.status}</p>
                  </div>
                  {index===0 && <span className="ir-version-current">Current</span>}
                </li>
              ))}
              {(task.artifactHistory || []).slice().reverse().map((record,index) => (
                <li key={record.artifact.id + ":" + record.artifact.version + ":" + index}>
                  <span className="ir-version-number">v{record.artifact.version}</span>
                  <div><strong>{record.artifact.title}</strong>
                    <p>{record.reason}</p>
                    <details><summary>Inspect stored version <ChevronDown size={15} /></summary>
                      <pre>{record.artifact.content}</pre>
                    </details>
                  </div>
                </li>
              ))}
              {!task.receipts?.length && !task.artifactHistory?.length && (
                <li><span className="ir-version-number">v{vm.revision}</span>
                  <div><strong>Current saved work</strong>
                    <p>No earlier version is recorded.</p></div>
                  <span className="ir-version-current">Current</span>
                </li>
              )}
            </ol>
            <p className="ir-footnote">Restoration is unavailable until Igor supports a confirmed server-side restore action. No revision is simulated locally.</p>
          </div>
        </div>
      )}

      {view === "maps" && (
        <>
          {(spatialNode || verifiedMap) && (
            <div className="ir-grounded-map-modes" role="group" aria-label="Map mode">
              <button type="button" aria-pressed={!advancedMap} onClick={() => setAdvancedMap(false)}>Map</button>
              <button type="button" aria-pressed={advancedMap} onClick={() => setAdvancedMap(true)}>3D / advanced</button>
            </div>
          )}
          {advancedMap && (spatialNode || verifiedMap) ? (
            spatialNode
              ? <TaskCanvas task={task} busy={busy} onTurn={onTurn} focusNodeId={spatialNode.id}/>
              : verifiedMap
          ) : (
            <GroundedMap
              places={vm.mapPlaces.map(({candidate,latitude,longitude})=>({
                id:candidate.id,name:candidate.name,latitude,longitude,
                address:candidate.place?.address || candidate.location || null,
              }))}
              busy={busy}
              onOpenPlace={(id)=>{setSelectedId(id);onNavigate("detail");}}
              onResearch={(area)=>void onTurn({type:"message",text:
                `Find places in ${area} that fit this task. Show source-backed results and actual coordinates only; preserve my previous work.`})}
            />
          )}
        </>
      )}
    </section>
  );
}
