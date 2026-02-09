// pages/api/recurring/client-rematch.ts
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

async function notifyToTopic(topic: string, payload: Record<string, any>) {
  try {
    await admin.messaging().send({
      topic,
      data: Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [k, String(v)]),
      ),
    });
  } catch {
    // best-effort; ignore notification failures
  }
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
    if (role !== "client") return res.status(403).json({ error: "Only clients can rematch." });

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

    // Ensure the caller owns the job
    const clientId = String(job.clientId ?? "").trim();
    if (!clientId || clientId !== callerUid) {
      return res.status(403).json({ error: "You do not own this job request." });
    }

    const providerUid = String(job.selectedProviderUid ?? "").trim();
    const holdId = String(job.holdId ?? "").trim();

    // 4) Best-effort delete hold timeBlock
    if (providerUid && holdId) {
      await db
        .collection("serviceProviders")
        .doc(providerUid)
        .collection("timeBlocks")
        .doc(holdId)
        .delete()
        .catch(() => {});
    }

    // 5) Clear job selection fields + set status to rematch
    await jobRef.set(
      {
        status: "rematch",
        selectedProviderUid: admin.firestore.FieldValue.delete(),
        providerName: admin.firestore.FieldValue.delete(),
        holdId: admin.firestore.FieldValue.delete(),
        holdExpiresAt: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 6) Notify previous provider (tap should open the correct recurring job manage/details flow)
    // We route to Updated Job Details (provider), since your app routes this reliably.
    if (providerUid) {
      await notifyToTopic(`user_${providerUid}`, {
        type: "provider_recurring_rematched",
        jobId: jobRequestId,
        route: "/updated_job_details_provider",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("client-rematch error:", err);
    return res.status(500).json({
      error: "Failed to rematch.",
      code: err?.code,
      message: err?.message,
    });
  }
}
