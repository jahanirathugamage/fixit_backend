// pages/api/geocode.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { geocodeWithNominatim } from "../../lib/geocode";

type Ok = { lat: number; lon: number; displayName?: string };
type Err = { error: string; details?: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Ok | Err>
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const qParam = req.query.q;
    const q = (Array.isArray(qParam) ? qParam[0] : qParam ?? "")
      .toString()
      .trim();

    if (!q) return res.status(400).json({ error: "Missing q" });

    // Build a stable referer + better UA so Nominatim can identify your app
    const host = req.headers.host ?? "";
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const referer = host ? `${proto}://${host}` : undefined;

    const result = await geocodeWithNominatim(q, {
      userAgent: "FixIt/1.0 (contact: your-email@example.com)",
      referer,
    });

    if (!result) return res.status(404).json({ error: "No results" });

    return res.status(200).json(result);
  } catch (e: unknown) {
    const details = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: "Server error", details });
  }
}
