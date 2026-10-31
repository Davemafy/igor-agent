"use client";

import type { Task } from "@/core/contracts";
import { ArrowUpRight, Plus } from "lucide-react";
import { adaptTaskForPresentation } from "./workspace-view-model";

type Props = {
  task: Task;
  busy: boolean;
  onOpen: (id: string) => void;
  onCompare: () => void;
};

/**
 * The inline preview seen in reference 03. It is deliberately absent when
 * there are no grounded recommendations; no imaginary six-person crew is
 * inserted into ordinary research conversations.
 */
export function ReferenceConversationResults({ task, busy, onOpen, onCompare }: Props) {
  const view = adaptTaskForPresentation(task);
  const candidates = view.candidates.filter((candidate) =>
    !candidate.sample &&
    (!("freshness" in candidate) || candidate.freshness === "current")
  ).slice(0, 3);
  const participants = view.participants.filter((person) => !person.sample);

  if (!candidates.length) { return null; }

  return (
    <section className="ir-conversation-recommendations" aria-label="Grounded recommendations from this conversation">
      {participants.length > 0 && (
        <div className="ir-people-strip" aria-label="People included in the saved task">
          {participants.slice(0, 8).map((person) => (
            <div className="ir-person" key={person.id}>
              <span className="ir-person-portrait" aria-hidden="true">
                {person.name.slice(0, 1).toUpperCase()}
              </span>
              <strong>{person.name}</strong>
              <small>{person.preferences.filter((preference) => preference.confirmed).slice(0, 2)
                .map((preference) => preference.value).join(" · ") || "Preferences not supplied"}</small>
            </div>
          ))}
        </div>
      )}
      <header className="ir-conversation-recommendations-header">
        <h2>{participants.length ? "Recommended for your group" : "Options from this research"}</h2>
        {candidates.length > 1 && (
          <button type="button" onClick={onCompare} disabled={busy}>
            Compare options <ArrowUpRight size={18} />
          </button>
        )}
      </header>
      <div className="ir-conversation-recommendation-grid">
        {candidates.map((candidate) => {
          const signals = view.culturalSignalsForCandidate(candidate.id);
          const matchingSignal = signals.find((signal) => signal.participantName) || signals[0];
          const evidence = view.evidenceForCandidate(candidate.id);

          return (
            <article key={candidate.id} className="ir-conversation-recommendation">
              <button type="button" className="ir-conversation-recommendation-image"
                aria-label={`Inspect ${candidate.name}`}
                onClick={() => onOpen(candidate.id)}>
                {candidate.imageUrl ? (
                  <img src={candidate.imageUrl} alt="" loading="lazy" />
                ) : <span className="ir-recommendation-no-photo">{candidate.type.replaceAll("_", " ")}</span>}
                <strong>{candidate.name}</strong>
              </button>
              <div className="ir-conversation-recommendation-description">
                <h3>{candidate.name}</h3>
                <p>{candidate.type.replaceAll("_", " ")}{candidate.duration.value != null ? ` · ${candidate.duration.value} min` : ""}</p>
                <h4>Why this fits</h4>
                <p>{matchingSignal
                  ? `${matchingSignal.participantName || "Context"} · rank #${matchingSignal.rankWithinQuery} in query ${matchingSignal.queryId}. ${matchingSignal.rawAffinity == null ? "No raw affinity returned." : `Raw Qloo affinity ${matchingSignal.rawAffinity}.`}`
                  : evidence.length ? `${evidence.length} saved source ${evidence.length === 1 ? "record" : "records"} available for inspection.`
                    : "No specific cultural explanation is available."}</p>
                <button type="button" disabled={busy} onClick={() => onOpen(candidate.id)}>
                  Inspect evidence <ArrowUpRight size={15} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="ir-conversation-evidence-note">Qloo evidence is query-scoped. Unknown preferences, rankings and logistical facts are not inferred.</p>
    </section>
  );
}
