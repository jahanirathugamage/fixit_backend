// lib/geocode.ts
export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
};

export async function geocodeWithNominatim(address: string): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;

  // Nominatim requires a valid User-Agent (and ideally contact info)
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FixIt/1.0 (contact: your-email@example.com)",
      "Accept": "application/json",
    },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as Array<any>;
  if (!data.length) return null;

  const first = data[0];
  const lat = Number(first.lat);
  const lon = Number(first.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    displayName: first.display_name,
  };
}
