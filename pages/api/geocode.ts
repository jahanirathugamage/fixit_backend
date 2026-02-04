import type { NextApiRequest, NextApiResponse } from "next";

type OkResponse = {
  lat: number;
  lon: number;
  displayName?: string;
};

type ErrResponse = {
  error: string;
  details?: string;
};

type NominatimItem = {
  lat?: string;
  lon?: string;
  display_name?: string;
};

async function geocodeSriLanka(address: string): Promise<OkResponse | null> {
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
        "User-Agent": "FixIt/1.0 (contact: your-email@example.com)",
        "Referer": "https://fixit-backend.vercel.app",
        "Accept": "application/json",
        "Accept-Language": "en",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Nominatim failed: ${res.status} ${res.statusText} ${body}`.trim(),
      );
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OkResponse | ErrResponse>,
) {
  try {
    const qRaw = req.query.q;
    const q = (Array.isArray(qRaw) ? qRaw[0] : qRaw ?? "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const result = await geocodeSriLanka(q);
    if (!result) return res.status(404).json({ error: "No results" });

    return res.status(200).json(result);
  } catch (e: unknown) {
    const details = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Server error", details });
  }
}
