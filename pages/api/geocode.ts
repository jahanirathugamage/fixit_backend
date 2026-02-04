import type { NextApiRequest, NextApiResponse } from "next";
import { geocodeWithNominatim } from "../../lib/geocode";

type OkResponse = {
  lat: number;
  lon: number;
  displayName?: string;
};

type ErrResponse = {
  error: string;
  details?: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OkResponse | ErrResponse>,
) {
  try {
    const qRaw = req.query.q;
    const q = (Array.isArray(qRaw) ? qRaw[0] : qRaw ?? "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const result = await geocodeWithNominatim(q);
    if (!result) return res.status(404).json({ error: "No results" });

    return res.status(200).json(result);
  } catch (e: unknown) {
    // IMPORTANT: return JSON so we can see the real reason
    const details = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Server error", details });
  }
}
