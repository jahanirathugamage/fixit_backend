// lib/geocode.ts
export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
};

type NominatimItem = {
  lat?: string;
  lon?: string;
  display_name?: string;
};

export async function geocodeWithNominatim(
  address: string,
): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  // Sri Lanka only (lk)
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json` +
    `&addressdetails=1` +
    `&countrycodes=lk` +
    `&limit=1` +
    `&q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "FixIt/1.0 (contact: your-email@example.com)",
      "Accept": "application/json",
    },
  });

  if (!res.ok) return null;

  const raw: unknown = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const first = raw[0] as NominatimItem;

  const lat = Number(first.lat);
  const lon = Number(first.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    displayName: first.display_name,
  };
}
