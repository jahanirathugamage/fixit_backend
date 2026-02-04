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

  const params = new URLSearchParams({
    format: "json",
    addressdetails: "1",
    countrycodes: "lk",
    limit: "1",
    q: query,
  });

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  // Timeout (8s)
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        // Nominatim policy: identify your app. Replace with your real email if possible.
        "User-Agent": "FixIt/1.0 (contact: your-email@example.com)",
        "Referer": "https://fixit-backend.vercel.app",
        "Accept": "application/json",
        "Accept-Language": "en",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Throwing helps us see the reason in API route error response
      throw new Error(`Nominatim failed: ${res.status} ${res.statusText} ${body}`.trim());
    }

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
  } finally {
    clearTimeout(t);
  }
}
