"use client";

import { useState } from "react";
import { ArrowRight, MapPin } from "lucide-react";

/** A geographic map that remains useful before task evidence arrives.
 * City presets move the view only; only verified task coordinates create pins.
 */
export type VerifiedMapPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address?: string | null;
};

const areas = [
  {name: "New York", latitude: 40.7128, longitude: -74.0060},
  {name: "London", latitude: 51.5074, longitude: -0.1278},
  {name: "Tokyo", latitude: 35.6762, longitude: 139.6503},
  {name: "Lisbon", latitude: 38.7223, longitude: -9.1393},
] as const;

export function GroundedMap({
  places = [],
  onOpenPlace,
  onResearch,
  busy = false,
}: {
  places?: readonly VerifiedMapPlace[];
  onOpenPlace?: (id: string) => void;
  onResearch?: (area: string) => void;
  busy?: boolean;
}) {
  const [city, setCity] = useState<(typeof areas)[number]["name"]>("New York");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [searchArea, setSearchArea] = useState("");

  const validPlaces = places.filter((item) =>
    Number.isFinite(item.latitude) && Math.abs(item.latitude) <= 90 &&
    Number.isFinite(item.longitude) && Math.abs(item.longitude) <= 180,
  );
  const selectedPlace = validPlaces.find((item) => item.id === selectedPlaceId) || null;
  const region = areas.find((item) => item.name === city) || areas[0];
  const latitude = selectedPlace?.latitude ?? region.latitude;
  const longitude = selectedPlace?.longitude ?? region.longitude;

  const bbox = selectedPlace
    ? [longitude - .025, latitude - .017, longitude + .025, latitude + .017]
    : [longitude - .10, latitude - .065, longitude + .10, latitude + .065];
  const mapUrl = new URL("https://www.openstreetmap.org/export/embed.html");
  mapUrl.searchParams.set("bbox", bbox.map((value) => value.toFixed(6)).join(","));
  mapUrl.searchParams.set("layer", "mapnik");

  if (selectedPlace) {
    mapUrl.searchParams.set("marker", [latitude, longitude].map((value) => value.toFixed(6)).join(","));
  }

  const externalMap = `https://www.openstreetmap.org/#map=13/${latitude}/${longitude}`;

  return (
    <section className="ir-grounded-map" aria-label="Interactive location map">
      <div className="ir-grounded-map-toolbar">
        <div className="ir-grounded-map-areas" role="group" aria-label="Move map to city">
          {areas.map((area) => (
            <button key={area.name} type="button"
              aria-pressed={!selectedPlace && city === area.name}
              onClick={() => {setCity(area.name);setSelectedPlaceId(null);}}>
              {area.name}
            </button>
          ))}
        </div>
        <a href={externalMap} target="_blank" rel="noopener noreferrer">Open full map <ArrowRight size={16}/></a>
      </div>
      <div className="ir-grounded-map-frame">
        <iframe
          key={mapUrl.toString()}
          title={`Interactive OpenStreetMap of ${selectedPlace?.name || city}`}
          src={mapUrl.toString()}
          loading="eager"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
        <span className="ir-grounded-map-state">
          {selectedPlace ? `Verified task place: ${selectedPlace.name}` : `${city} map view · no suggested pins`}
        </span>
      </div>
      <div className="ir-grounded-map-credit">
        <span>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> · ODbL</span>
        <span>{validPlaces.length} verified {validPlaces.length === 1 ? "place" : "places"} in this conversation</span>
      </div>
      <div className="ir-grounded-map-footer">
        <form onSubmit={(event) => {
          event.preventDefault();
          onResearch?.(searchArea.trim() || selectedPlace?.address || city);
        }}>
          <label htmlFor="igor-map-search">Find places in another city or neighborhood</label>
          <div>
            <input id="igor-map-search" value={searchArea}
              onChange={(event) => setSearchArea(event.target.value)}
              placeholder="Enter a place" autoComplete="off"/>
            <button type="submit" disabled={!onResearch || busy}>Research places <ArrowRight size={16}/></button>
          </div>
        </form>
        {validPlaces.length > 0 && (
          <div className="ir-grounded-map-places" aria-label="Verified task places">
            {validPlaces.map((place) => (
              <button type="button" key={place.id} aria-pressed={selectedPlace?.id === place.id}
                onClick={() => {setSelectedPlaceId(place.id);}}>
                <MapPin size={16} aria-hidden="true"/>
                <span>{place.name}</span>
              </button>
            ))}
            {selectedPlace && onOpenPlace && (
              <button className="ir-grounded-map-details" type="button" onClick={()=>onOpenPlace(selectedPlace.id)}>
                Details for {selectedPlace.name} <ArrowRight size={16}/>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
