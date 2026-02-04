// pages/api/ping.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { applyCors } from "../../lib/cors";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const handled = applyCors(req, res);
  if (handled) return;

  return res.status(200).json({ ok: true });
}
