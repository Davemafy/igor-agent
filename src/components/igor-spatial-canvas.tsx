"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  MapPin,
  Map as MapIcon,
  List,
  RefreshCw,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Candidate, CandidateInput, Task } from "@/core/contracts";
import type { CanvasMutation, PresentationNode } from "@/core/presentation";

type Position = { lat: number; lng: number; altitude?: number };
type MapElement = HTMLElement & {
  center: Position;
  range: number;
  tilt: number;
  heading: number;
  flyCameraTo: (options: unknown) => void;
  stopCameraAnimation: () => void;
};
type Maps3DLibrary = {
  Map3DElement: new (options: unknown) => MapElement;
  Marker3DInteractiveElement: new (options: unknown) => HTMLElement;
  MarkerInteractiveElement?: new (options: unknown) => HTMLElement;
};
type MapsAPI = { importLibrary: (name: string) => Promise<unknown> };
type MapsWindow = Window & {
  google?: { maps?: MapsAPI };
  igorMapsReady?: () => void;
};
let mapsPromise: Promise<MapsAPI> | undefined;

function loadMaps(): Promise<MapsAPI> {
  const win = window as MapsWindow;

  if (win.google?.maps?.importLibrary) {
    return Promise.resolve(win.google.maps);
  }

  if (mapsPromise) {
    return mapsPromise;
  }

  mapsPromise = (async () => {
    const response = await fetch("/api/maps/config");

    if (!response.ok) {
      throw new Error("The map could not be configured.");
    }

    const config = (await response.json()) as { browserKey?: string };

    if (!config.browserKey) {
      throw new Error(
        "Maps are not configured. Your grounded places and plan are still available.",
      );
    }

    return new Promise<MapsAPI>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("The map took too long to load."));
      }, 20000);

      function cleanup() {
        clearTimeout(timer);
        delete win.igorMapsReady;
      }

      win.igorMapsReady = () => {
        const api = win.google?.maps;
        cleanup();

        if (api) {
          resolve(api);
        } else {
          reject(new Error("Maps is unavailable on this device."));
        }
      };

      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.browserKey!)}&v=weekly&loading=async&callback=igorMapsReady`;
      script.async = true;

      script.onerror = () => {
        cleanup();
        script.remove();
        reject(new Error("Google Maps could not load. Check your connection."));
      };

      document.head.append(script);
    });
  })();

  // Rejection must not poison later explicit retries. A failure never
  // fabricates an available map or silently switches the provider.
  return mapsPromise.catch((error: unknown) => {
    mapsPromise = undefined;
    throw error;
  });
}

const position = (c: Candidate | CandidateInput): Position => ({
  lat: c.place!.latitude!,
  lng: c.place!.longitude!,
  altitude: 0,
});

export default function IgorSpatialCanvas({
  task,
  node,
  busy,
  mutate,
  selectedCandidateId,
}: {
  task: Task;
  node: Extract<PresentationNode, { candidateIds: string[] }>;
  busy: boolean;
  mutate: (mutation: CanvasMutation) => void;
  selectedCandidateId?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<MapElement | null>(null);
  const flatMap = useRef<{ panTo: (p: Position) => void } | null>(null);
  const markers = useRef(
    new Map<
      string,
      {
        element?: HTMLElement;
        flat?: {
          setOpacity?: (value: number) => void;
          setZIndex?: (value: number) => void;
        };
      }
    >(),
  );
  const mutationRef = useRef(mutate);
  const busyRef = useRef(busy);
  useEffect(() => {
    mutationRef.current = mutate;
    busyRef.current = busy;
  }, [mutate, busy]);
  const [mapQuery, setMapQuery] = useState("");
  const [mapCategory, setMapCategory] = useState("All");
  const availableCandidates = useMemo(
    () =>
      node.candidateIds
        .map((id) => (task.candidates.find((c) => c.id === id) ?? task.catalogue.find((c) => c.id === id)))
        .filter(
          (c): c is Candidate | CandidateInput =>
            !!c && c.type === "place" && !c.sample && !!c.providerId &&
            (!("freshness" in c) || c.freshness === "current"),
        ),
    [node.candidateIds, task.candidates],
  );
  const candidates = useMemo(() => availableCandidates.filter((candidate) => {
    const text = [candidate.name, candidate.description, candidate.place?.address ?? "", ...candidate.tags]
      .join(" ").toLowerCase();

    return text.includes(mapQuery.trim().toLowerCase()) &&
      (mapCategory === "All" || text.includes(mapCategory.toLowerCase()));
  }), [availableCandidates, mapQuery, mapCategory]);
  const places = useMemo(
    () =>
      candidates.filter((c) => {
        const lat = c.place?.latitude;
        const lng = c.place?.longitude;

        return (
          lat != null &&
          lng != null &&
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lng) <= 180
        );
      }),
    [candidates],
  );

  function markersRefSet(
    id: string,
    marker: {
      element?: HTMLElement;
      flat?: {
        setOpacity?: (value: number) => void;
        setZIndex?: (value: number) => void;
      };
    },
  ) {
    markers.current.set(id, marker);
    const active = id === selectedId || (!selectedId && id === places[0]?.id);
    marker.element?.toggleAttribute("data-selected", active);
    marker.element?.setAttribute("aria-pressed", String(active));
    marker.flat?.setOpacity?.(active ? 1 : 0.72);
    marker.flat?.setZIndex?.(active ? 1000 : 1);
  }

  const signature = places
    .map((c) => `${c.id}:${c.place!.latitude}:${c.place!.longitude}`)
    .join("|");
  const placesRef = useRef(places);
  useEffect(() => {
    placesRef.current = places;
  }, [places]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [userEnabled, setEnabled] = useState(false);
  const [twoD, setTwoD] = useState(true);
  const [requestedView, setRequestedView] = useState<"map" | "list">("map");
  const viewMode = places.length ? requestedView : "list";
  const enabled = userEnabled || (places.length > 0 && requestedView === "map");
  const [retryKey, setRetryKey] = useState(0);
  const selectedId = selectedCandidateId ?? task.canvas?.selectedCandidateId;
  const selected = candidates.find((c) => c.id === selectedId) || candidates[0];
  const itinerary = task.canvas?.itineraryIds || [];
  // Selection is owned by the versioned Task, not by map-local state.
  // Both map markers and the place list reflect the same persisted identity.
  useEffect(() => {
    for (const [id, marker] of markers.current) {
      const active = id === selected?.id;
      marker.element?.toggleAttribute("data-selected", active);
      marker.element?.setAttribute("aria-pressed", String(active));
      const label = candidates.find((item) => item.id === id)?.name ?? id;
      marker.element?.setAttribute(
        "aria-label",
        active ? `${label} selected` : label,
      );
      marker.flat?.setOpacity?.(active ? 1 : 0.72);
      marker.flat?.setZIndex?.(active ? 1000 : 1);
    }
  }, [selected?.id, state, candidates]);
  useEffect(() => {
    const el = host.current;

    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      // The element itself is responsive. On 2D, Google Maps requires an
      // explicit event-less pan after orientation or container size changes.
      if (viewMode === "map" && flatMap.current && selected?.place) {
        flatMap.current.panTo(position(selected));
      }
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, [viewMode, selected?.id]);
  const camera = useRef<{
    center: Position;
    range: number;
    tilt: number;
    heading: number;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !signature) {
      return;
    }

    let active = true;
    const container = host.current;

    let cleanup = () => {};

    (async () => {
      await Promise.resolve();

      if (!active) {
        return;
      }

      setState("loading");
      setError("");
      const api = await loadMaps();

      if (!active || !container) {
        return;
      }

      if (twoD) {
        type FlatMap = { panTo: (p: Position) => void };
        type MapOverlay = {
          onAdd: () => void;
          draw: () => void;
          onRemove: () => void;
          setMap: (map: FlatMap | null) => void;
          getPanes: () => {overlayMouseTarget: HTMLElement} | null;
          getProjection: () => {
            fromLatLngToDivPixel: (point: Position) => {x:number; y:number} | null
          };
        };
        const lib = (await api.importLibrary("maps")) as {
          Map: new (el: HTMLElement, options: unknown) => FlatMap;
          OverlayView: new () => MapOverlay;
        };

        if (!active) {
          return;
        }

        const flat = new lib.Map(container, {
          center: position(placesRef.current[0]),
          zoom: 13,
          gestureHandling: "cooperative",
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          styles: [
            {elementType:"geometry",stylers:[{color:"#102638"}]},
            {elementType:"labels.text.fill",stylers:[{color:"#cad9e3"}]},
            {elementType:"labels.text.stroke",stylers:[{color:"#071a2a"}]},
            {featureType:"water",elementType:"geometry",stylers:[{color:"#071e32"}]},
            {featureType:"road",elementType:"geometry",stylers:[{color:"#294253"}]},
            {featureType:"road",elementType:"geometry.stroke",stylers:[{color:"#102d40"}]},
            {featureType:"poi.park",elementType:"geometry",stylers:[{color:"#173c37"}]},
            {featureType:"poi",elementType:"labels.icon",stylers:[{visibility:"off"}]},
            {featureType:"transit",elementType:"labels.icon",stylers:[{visibility:"off"}]},
          ],
        });
        flatMap.current = flat;
        // OverlayView anchors every photo marker to provider-backed lat/lng.
        // The provider reprojects it as the real map pans, tilts and zooms.
        const stops = placesRef.current.map((candidate) => {
          const overlay = new lib.OverlayView();
          const markerButton = document.createElement("button");
          markerButton.type = "button";
          markerButton.className = "ic-photo-map-pin";
          markerButton.setAttribute("aria-label", `Select ${candidate.name}`);
          markerButton.title = candidate.name;

          if (candidate.imageUrl) {
            const image = document.createElement("img");
            image.src = candidate.imageUrl;
            image.alt = "";
            image.loading = "lazy";
            image.referrerPolicy = "no-referrer";
            image.addEventListener("error", () => image.remove());
            markerButton.append(image);
          } else {
            const letter = document.createElement("span");
            letter.textContent = candidate.name.slice(0,1);
            markerButton.append(letter);
          }

          const select = () => {
            if (!busyRef.current) {
              mutationRef.current({operation:"select", nodeId:node.id, candidateId:candidate.id});
            }
          };

          markerButton.addEventListener("click",select);

          overlay.onAdd = () => {
            overlay.getPanes()?.overlayMouseTarget.append(markerButton);
          };

          overlay.draw = () => {
            const pixel = overlay.getProjection().fromLatLngToDivPixel(position(candidate));

            if (pixel) {
              markerButton.style.left = `${pixel.x}px`;
              markerButton.style.top = `${pixel.y}px`;
            }
          };

          overlay.onRemove = () => markerButton.remove();
          overlay.setMap(flat);
          markersRefSet(candidate.id,{element:markerButton});

          return () => {
            markerButton.removeEventListener("click",select);
            overlay.setMap(null);
            markers.current.delete(candidate.id);
          };
        });

        cleanup = () => {
          flatMap.current = null;
          stops.forEach((stop) => stop());
          container.replaceChildren();
        };

        setState("ready");

        return;
      }

      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");

      if (!gl) {
        throw new Error("This device cannot display 3D Maps. Try the 2D map.");
      }

      gl.getExtension("WEBGL_lose_context")?.loseContext();
      const library = (await api.importLibrary("maps3d")) as Maps3DLibrary;

      if (!active) {
        return;
      }

      if (!library.Map3DElement || !library.Marker3DInteractiveElement) {
        throw new Error("3D Maps is unavailable. Try the 2D map.");
      }

      const all = placesRef.current;
      const bounds = all.reduce(
        (b, c) => ({
          minLat: Math.min(b.minLat, c.place!.latitude!),
          maxLat: Math.max(b.maxLat, c.place!.latitude!),
          minLng: Math.min(b.minLng, c.place!.longitude!),
          maxLng: Math.max(b.maxLng, c.place!.longitude!),
        }),
        { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 },
      );
      // View framing only, never a route or travel-time calculation.
      const span = Math.max(
        bounds.maxLat - bounds.minLat,
        bounds.maxLng - bounds.minLng,
      );
      const view = camera.current || {
        center: {
          lat: (bounds.minLat + bounds.maxLat) / 2,
          lng: (bounds.minLng + bounds.maxLng) / 2,
          altitude: 0,
        },
        range: Math.max(1800, Math.min(20000000, span * 150000)),
        tilt: 55,
        heading: 0,
      };
      const element = new library.Map3DElement({
        ...view,
        mode: "ROADMAP",
        colorScheme: "DARK",
        gestureHandling: "COOPERATIVE",
      });
      element.style.width = "100%";
      element.style.height = "100%";

      const updateCamera = () => {
        camera.current = {
          center: element.center,
          range: element.range,
          tilt: element.tilt,
          heading: element.heading,
        };
      };

      const fail = () => {
        if (active) {
          setError(
            "3D Maps could not render. Your selected places are saved. Try the 2D map.",
          );
          setState("error");
        }
      };

      const loaded = (event: Event) => {
        if (active && (event as Event & { isSteady?: boolean }).isSteady) {
          setState("ready");
        }
      };

      element.addEventListener("gmp-error", fail);
      element.addEventListener("gmp-centerchange", updateCamera);
      element.addEventListener("gmp-rangechange", updateCamera);
      element.addEventListener("gmp-steadychange", loaded);
      const listeners: (() => void)[] = [];

      for (const c of all) {
        const marker = library.MarkerInteractiveElement
          ? new library.MarkerInteractiveElement({
              position: position(c),
              title: c.name,
              altitudeMode: "CLAMP_TO_GROUND",
            })
          : new library.Marker3DInteractiveElement({
              position: position(c),
              label: c.name,
              altitudeMode: "CLAMP_TO_GROUND",
            });

        if (library.MarkerInteractiveElement) {
          const chip = document.createElement("div");
          chip.className = "ic-map-3d-label";

          if (c.imageUrl) {
            const photo = document.createElement("img");
            photo.src = c.imageUrl;
            photo.alt = "";
            photo.referrerPolicy = "no-referrer";
            photo.addEventListener("error", () => photo.remove());
            chip.append(photo);
          }

          const name = document.createElement("strong");
          name.textContent = c.name;
          chip.append(name);
          marker.append(chip);
        }

        const select = () => {
          if (!busyRef.current) {
            mutationRef.current({
              operation: "select",
              nodeId: node.id,
              candidateId: c.id,
            });
          }
        };

        marker.addEventListener("gmp-click", select);

        // Browser and test-double markers also support keyboard selection.
        const keySelect = (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select();
          }
        };

        marker.addEventListener("keydown", keySelect);
        marker.setAttribute("aria-label", c.name);
        marker.setAttribute("tabindex", "0");
        markersRefSet(c.id, { element: marker });
        element.append(marker);
        listeners.push(() => {
          marker.removeEventListener("gmp-click", select);
          marker.removeEventListener("keydown", keySelect);
          markers.current.delete(c.id);
        });
      }

      container.replaceChildren(element);
      map.current = element;
      const timeout = window.setTimeout(() => {
        if (active) {
          setState((current) => {
            if (current !== "loading") {
              return current;
            }

            setError(
              "The 3D scene has not finished loading. Try the 2D map or continue with the place list.",
            );

            return "error";
          });
        }
      }, 20000);

      cleanup = () => {
        clearTimeout(timeout);
        listeners.forEach((stop) => stop());
        element.removeEventListener("gmp-error", fail);
        element.removeEventListener("gmp-centerchange", updateCamera);
        element.removeEventListener("gmp-rangechange", updateCamera);
        element.removeEventListener("gmp-steadychange", loaded);
        element.stopCameraAnimation();
        element.remove();
        map.current = null;
      };
    })().catch((failure: unknown) => {
      if (active) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The map is unavailable. Use the place links below.",
        );
        setState("error");
      }
    });

    return () => {
      active = false;
      cleanup();
    };
  }, [enabled, signature, twoD, node.id, retryKey]);
  const selectedLat = selected?.place?.latitude;
  const selectedLng = selected?.place?.longitude;
  useEffect(() => {
    if (selectedLat == null || selectedLng == null || state !== "ready") {
      return;
    }

    if (flatMap.current) {
      flatMap.current.panTo({ lat: selectedLat, lng: selectedLng });

      return;
    }

    if (!map.current) {
      return;
    }

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const endCamera = {
      center: { lat: selectedLat, lng: selectedLng, altitude: 0 },
      range: 1800,
      tilt: 55,
      heading: map.current.heading || 0,
    };

    if (reduced) {
      Object.assign(map.current, endCamera);
    } else {
      map.current.stopCameraAnimation();
      map.current.flyCameraTo({ endCamera, durationMillis: 1000 });
    }
  }, [selectedLat, selectedLng, state]);

  function updateItinerary(ids: string[]) {
    mutate({ operation: "itinerary", nodeId: node.id, candidateIds: ids });
  }

  if (!candidates.length) {
    return (
      <p className="ic-note">
        No current places are available. Igor will not invent coordinates or
        reuse stale locations to fill a map.
      </p>
    );
  }

  return (
    <div className="ic-spatial" data-map-mode={viewMode} data-spatial-dimension={twoD ? "2d" : "3d"}>
      <div className="ic-reference-map-controls" aria-label="Place search and filters">
        <label className="ic-reference-map-search">
          <Search size={23}/>
          <span className="pp-visually-hidden">Search mapped places</span>
          <input type="search" placeholder="Search places, neighbourhoods or a particular kind of place"
            value={mapQuery} onChange={(event) => setMapQuery(event.target.value)}/>
        </label>
        <div className="ic-reference-map-filters" role="group" aria-label="Filter mapped places">
          {["All","Films","Music","Dining","Bars","Art","Culture"].map((kind) => (
            <button key={kind} aria-pressed={mapCategory===kind}
              onClick={() => setMapCategory(kind)}>{kind}</button>
          ))}
        </div>
      </div>
      <div className="ic-dimensional-switch" role="group" aria-label="Map dimension">
        <button type="button" aria-pressed={twoD}
          onClick={() => { setTwoD(true); setRequestedView("map"); setEnabled(true); }}
          disabled={!places.length}>2D</button>
        <button type="button" aria-pressed={!twoD}
          onClick={() => { setTwoD(false); setRequestedView("map"); setEnabled(true); }}
          disabled={!places.length}>3D</button>
      </div>
      <div className="ic-spatial-heading">
        <div>
          <span className="ic-eyebrow">Explore places</span>
          <strong>
            {candidates.length} {candidates.length === 1 ? "place" : "places"} ·{" "}
            {places.length} mappable
          </strong>
        </div>
        <div
          className="ic-spatial-view-switch"
          role="group"
          aria-label="Geographic result view"
        >
          <button
            type="button"
            aria-pressed={viewMode === "map"}
            onClick={() => setRequestedView("map")}
            disabled={!places.length}
            title={
              !places.length
                ? "No current places have valid coordinates"
                : undefined
            }
          >
            <MapIcon /> Map
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "list"}
            onClick={() => setRequestedView("list")}
          >
            <List /> List
          </button>
        </div>
      </div>
      {!places.length && (
        <p className="ic-note" role="status">
          No current coordinates are available. Place cards and your itinerary
          remain editable; mapping must wait for real location data.
        </p>
      )}
      <div
        className="ic-map-stage"
        hidden={viewMode === "list" || !places.length}
      >
        <div
          className="ic-map-host"
          ref={host}
          aria-label={twoD ? "Google 2D map" : "Google Photorealistic 3D map"}
        />
        {!enabled && (
          <div className="ic-map-start">
            <MapPin />
            <h4>Your places, in context.</h4>
            <p>
              Open the map when you want to explore. Your plan stays in this
              conversation.
            </p>
            <div className="ic-map-start-actions">
              <button
                type="button"
                onClick={() => {
                  setTwoD(false);
                  setEnabled(true);
                }}
              >
                Explore in 3D <ExternalLink />
              </button>
              <button
                type="button"
                onClick={() => {
                  setTwoD(true);
                  setEnabled(true);
                }}
              >
                Use 2D map
              </button>
            </div>
          </div>
        )}
        {enabled && state === "loading" && (
          <p className="ic-map-status" role="status">
            Loading Google Maps…
          </p>
        )}
        {enabled && state === "error" && (
          <div className="ic-map-status" role="status">
            <p>{error}</p>
            <div className="ic-map-error-actions">
              {!twoD && (
                <button type="button" onClick={() => setTwoD(true)}>
                  Use 2D map
                </button>
              )}
              <button
                type="button"
                onClick={() => setRetryKey((value) => value + 1)}
              >
                <RefreshCw /> Retry map
              </button>
              <button type="button" onClick={() => setRequestedView("list")}>
                Use place list
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        className="ic-place-selector"
        role="group"
        aria-label="Choose a place"
      >
        {candidates.map((c) => (
          <button
            key={c.id}
            type="button"
            className="ic-place-card"
            data-selected={selected?.id === c.id}
            disabled={busy}
            aria-pressed={selected?.id === c.id}
            onClick={() =>
              mutate({
                operation: "select",
                nodeId: node.id,
                candidateId: c.id,
              })
            }
          >
            {c.imageUrl ? (
              <img src={c.imageUrl} alt="" loading="lazy" />
            ) : (
              <span className="ic-place-card-fallback" aria-hidden="true">
                <MapPin />
              </span>
            )}
            <span className="ic-place-card-copy">
              <strong>{c.name}</strong>
              <small>{c.place?.address || "Location not confirmed"}</small>
            </span>
            {selected?.id === c.id && <Check aria-hidden="true" />}
          </button>
        ))}
      </div>
      {selected && (
        <article
          className="ic-place-preview"
          aria-label="Selected place detail"
        >
          {selected.imageUrl && <img src={selected.imageUrl} alt="" />}
          <div>
            <small>{selected.place?.address}</small>
            <h4 aria-live="polite">{selected.name}</h4>
            {!places.some((place) => place.id === selected.id) && (
              <p className="ic-note" role="status">
                This place has no usable coordinates. It can remain in the
                itinerary, but the map cannot focus on it.
              </p>
            )}
            <p>{selected.description}</p>
            <p className="ic-note">
              Qloo taste associations do not verify hours, routes, prices or
              availability.
            </p>
            <div className="ic-place-actions">
              <button
                disabled={busy || itinerary.includes(selected.id)}
                onClick={() => updateItinerary([...itinerary, selected.id])}
              >
                {itinerary.includes(selected.id) ? <Check /> : <Plus />}
                {itinerary.includes(selected.id)
                  ? "Added to your plan"
                  : "Add to your plan"}
              </button>
              {places.some((place) => place.id === selected.id) && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${selected.place!.latitude!},${selected.place!.longitude!}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open map <ExternalLink />
                </a>
              )}
            </div>
          </div>
        </article>
      )}
      {itinerary.length > 0 && (
        <div className="ic-map-plan">
          <h4>Your place order</h4>
          <ol>
            {itinerary.map((id, i) => {
              const c = task.candidates.find((p) => p.id === id);

              return (
                <li key={id}>
                  <span>{i + 1}</span>
                  <strong>
                    {c?.name || "Previously selected place"}
                    {c?.freshness !== "current" && <small> Needs review</small>}
                  </strong>
                  <label className="ic-itinerary-day">
                    <span className="pp-visually-hidden">
                      Day for {c?.name || "place"}
                    </span>
                    <select
                      aria-label={`Day for ${c?.name || "place"}`}
                      value={task.canvas?.itineraryDays?.[id] ?? 0}
                      disabled={busy || c?.freshness !== "current"}
                      onChange={(event) =>
                        mutate({
                          operation: "itinerary-day",
                          nodeId: node.id,
                          candidateId: id,
                          day: Number(event.target.value),
                        })
                      }
                    >
                      <option value={0}>Day unset</option>
                      {Array.from({ length: 14 }, (_, day) => (
                        <option key={day + 1} value={day + 1}>
                          Day {day + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={busy || i === 0}
                    aria-label={`Move ${c?.name || "place"} earlier`}
                    onClick={() => {
                      const ids = [...itinerary];
                      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                      updateItinerary(ids);
                    }}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    disabled={busy || i === itinerary.length - 1}
                    aria-label={`Move ${c?.name || "place"} later`}
                    onClick={() => {
                      const ids = [...itinerary];
                      [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                      updateItinerary(ids);
                    }}
                  >
                    <ArrowDown />
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`Remove ${c?.name || "place"}`}
                    onClick={() =>
                      updateItinerary(itinerary.filter((key) => key !== id))
                    }
                  >
                    <Trash2 />
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="ic-note">
            This is an editable place order, with no inferred travel times.
          </p>
        </div>
      )}
    </div>
  );
}
