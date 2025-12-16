import type { NextApiRequest, NextApiResponse } from "next";

type Geo = { lat: number; lng: number };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const address = String(req.query.address || "").trim();
  if (!address) return res.status(400).json({ error: "Pass ?address=..." });

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(address)}` +
    `&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== "OK" || !data.results?.length) {
    return res.status(400).json({
      error: "Geocoding failed",
      status: data.status,
      message: data.error_message,
      raw: data,
    });
  }

  const loc = data.results[0].geometry.location;
  const geo: Geo = { lat: Number(loc.lat), lng: Number(loc.lng) };

  return res.status(200).json({ ok: true, address, geo });
}
