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

function isNominatimArray(data: unknown): data is NominatimItem[] {
  return Array.isArray(data);
}

export async function geocodeWithNominatim(
  address: string,
  opts?: { userAgent?: string; referer?: string }
): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  // Sri Lanka only (lk)
  const url =
    `https` +
    `https://nominatim.openstreetmap.org/search` +
    `?format=json` +
    `&addressdetails=1` +
    `&countrycodes=lk` +
    `&limit=1` +
    `&q=${encodeURIComponent(query)}`;

  // IMPORTANT:
  // Nominatim requires a valid User-Agent (and ideally a contact email).
  // Vercel can also benefit from a Referer header for identification.
  const userAgent =
    opts?.userAgent ?? "FixIt/1.0 (contact: your-email@example.com)";
  const referer = opts?.referer;

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/json",
  };

  if (referer) headers.Referer = referer;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Nominatim failed: ${res.status} ${res.statusText} ${body}`);
  }

  const raw: unknown = await res.json();

  if (!isNominatimArray(raw) || raw.length === 0) return null;

  const first = raw[0];
  const lat = Number(first.lat);
  const lon = Number(first.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    displayName: first.display_name,
  };
}
