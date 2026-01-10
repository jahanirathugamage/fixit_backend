/* eslint-disable @typescript-eslint/no-explicit-any */

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function getCallerRole(uid: string): Promise<string | null> {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return snap.exists ? (snap.data()?.role as string) : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Auth
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const role = await getCallerRole(callerUid);
    if (role !== "client") return res.status(403).json({ error: "Only clients can cancel holds." });

    // 2) Body
    const { jobId = "" } = req.body || {};
    const jobRequestId = String(jobId).trim();
    if (!jobRequestId) return res.status(400).json({ error: "Missing jobId." });

    const db = admin.firestore();

    // 3) Load jobRequest
    const jobRef = db.collection("jobRequest").doc(jobRequestId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job request not found." });

    const job = jobSnap.data() as any;

    // Ensure the caller owns the job (extra safety)
    const clientId = String(job.clientId ?? "").trim();
    if (!clientId || clientId !== callerUid) {
      return res.status(403).json({ error: "You do not own this job request." });
    }

    const providerUid = String(job.selectedProviderUid ?? "").trim();
    const holdId = String(job.holdId ?? "").trim();

    // 4) Delete hold timeBlock if we have enough info
    if (providerUid && holdId) {
      await db
        .collection("serviceProviders")
        .doc(providerUid)
        .collection("timeBlocks")
        .doc(holdId)
        .delete()
        .catch(() => {});
    }

    // 5) Clear job fields (and set status)
    await jobRef.set(
      {
        status: "cancelled_by_client",
        selectedProviderUid: admin.firestore.FieldValue.delete(),
        holdId: admin.firestore.FieldValue.delete(),
        holdExpiresAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("cancel-hold error:", err);
    return res.status(500).json({
      error: "Failed to cancel hold.",
      code: err?.code,
      message: err?.message,
    });
  }
}
