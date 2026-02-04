// lib/geocode.ts
export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
};

type PhotonProperties = {
  name?: string;
  city?: string;
  country?: string;
};

type PhotonGeometry = {
  coordinates?: [number, number]; // [lon, lat]
};

type PhotonFeature = {
  geometry?: PhotonGeometry;
  properties?: PhotonProperties;
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPhotonResponse(value: unknown): value is PhotonResponse {
  if (!isObject(value)) return false;

  const features = value["features"];
  if (features === undefined) return true; // allow missing features

  return Array.isArray(features);
}

// Keeping function name for compatibility with your existing import/calls
export async function geocodeWithNominatim(
  address: string,
  opts?: { userAgent?: string; referer?: string }
): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  // Photon API (no key)
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;

  const userAgent =
    opts?.userAgent ?? "FixIt/1.0 (contact: your-email@example.com)";
  const referer = opts?.referer;

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/json",
  };
  if (referer) headers.Referer = referer;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;

    const raw: unknown = await res.json();
    if (!isPhotonResponse(raw)) return null;

    const features = raw.features ?? [];
    if (!features.length) return null;

    const first = features[0];
    const coords = first.geometry?.coordinates;
    if (!coords || coords.length !== 2) return null;

    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const name = first.properties?.name ?? "";
    const city = first.properties?.city ?? "";
    const country = first.properties?.country ?? "";
    const displayName =
      [name, city, country].filter(Boolean).join(", ") || undefined;

    return { lat, lon, displayName };
  } finally {
    clearTimeout(timeout);
  }
}
