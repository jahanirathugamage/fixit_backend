// lib/geocode.ts
export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
};

type NominatimItem = {
  lat?: string | number;
  lon?: string | number;
  display_name?: string;
};

function toNumber(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function geocodeWithNominatim(address: string): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  // Sri Lanka only (lk)
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json` +
    `&addressdetails=1` +
    `&countrycodes=lk` +
    `&limit=5` +
    `&q=${encodeURIComponent(query)}`;

  // ✅ Nominatim requires an identifying User-Agent (and ideally a Referer)
  // Put real values here (or set env vars on Vercel).
  const userAgent =
    process.env.NOMINATIM_USER_AGENT ??
    "FixIt/1.0 (contact: fixit-app@example.com)";

  const referer =
    process.env.NOMINATIM_REFERER ??
    "https://fixit-backend.vercel.app";

  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      "Referer": referer,
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    // Return null so your API route can send a clean error
    return null;
  }

  const raw: unknown = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const first = raw[0] as NominatimItem;

  const lat = toNumber(first.lat);
  const lon = toNumber(first.lon);
  if (lat === null || lon === null) return null;

  return {
    lat,
    lon,
    displayName: first.display_name,
  };
}
