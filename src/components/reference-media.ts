/**
 * Igor's fixed illustrative image slots. Source pages are recorded for
 * licensing and art direction; these are NOT evidence about Qloo entities,
 * actual venues, people or bookings. Real candidates use their own imageUrl.
 *
 * Source list: Davemafy/qloo-test/production/assets/igor-photo-sources.txt.
 * Pexels license: https://www.pexels.com/license/
 *
 * This mapping supplies stable, visually distinct editorial photography until
 * owner-provided original assets are versioned under /public/reference-art.
 */
const pexels = (id: string, width = 1200) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${width}`;

const editorial: Record<string, string> = {
  "home-story-1.webp": pexels("4881679",700),
  "home-story-2.webp": pexels("14471525",700),
  "home-story-3.webp": pexels("9419405",700),
  "home-story-4.webp": pexels("28056036",700),
  "home-story-5.webp": pexels("40489698",700),
  "discover-trending-1.webp": pexels("7991436",700),
  "discover-trending-2.webp": pexels("9419405",700),
  "discover-trending-3.webp": pexels("6955643",700),
  "discover-trending-4.webp": pexels("35437598",700),
  "discover-trending-5.webp": pexels("6816732",700),
  "discover-crew-1.webp": pexels("8921578",700),
  "discover-crew-2.webp": pexels("9419405",700),
  "discover-crew-3.webp": pexels("33033789",700),
  "discover-crew-4.webp": pexels("26729545",700),
  "discover-crew-5.webp": pexels("37178237",700),
  "create-film-portrait.webp": pexels("7991436",1000),
  "create-dining.webp": pexels("8921578",1000),
  "create-music.webp": pexels("9419405",1000),
  "plan-editorial-cover.webp": pexels("6955643",1000),
  "library-cover-1.webp": pexels("8921578",900),
  "library-cover-2.webp": pexels("33033789",900),
  "library-cover-3.webp": pexels("7991436",900),
  "library-cover-4.webp": pexels("6816732",900),
  "library-cover-5.webp": pexels("9419405",900),
  "library-cover-6.webp": pexels("31080809",900),
  "detail-photo-portrait.webp": pexels("6955643",1200),
};

/** Use only for curated moodboard/story assets, never canonical result media. */
export function referenceImageUrl(name: string): string {
  return editorial[name] || `/reference-art/${encodeURIComponent(name)}`;
}
