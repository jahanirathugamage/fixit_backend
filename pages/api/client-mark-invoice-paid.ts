// pages/api/client-mark-invoice-paid.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    const jobId = asString((req.body as { jobId?: unknown } | undefined)?.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const providerUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !providerUid) {
      return res.status(400).json({ error: "Job missing clientId/providerUid" });
    }
    if (clientId !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not job client)" });
    }

    // Mark pending provider confirmation
    await jobRef.set(
      {
        status: "completed_pending_payment",
        invoicePaidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Notify provider to confirm payment received
    await admin.messaging().send({
      topic: `user_${providerUid}`,
      notification: {
        title: "Payment Received?",
        body: "Client marked invoice as paid. Please confirm receipt.",
      },
      data: {
        type: "provider_confirm_final_payment",
        route: "/provider/confirm_final_payment",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      android: { priority: "high" },
    });

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
