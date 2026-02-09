// pages/api/recurring/provider-end.ts
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

async function deleteAllTimeBlocks(
  db: FirebaseFirestore.Firestore,
  providerUid: string,
  jobId: string,
) {
  const col = db.collection("serviceProviders").doc(providerUid).collection("timeBlocks");
  const q = await col.where("jobId", "==", jobId).get().catch(() => null);
  if (!q || q.empty) return;

  const batch = db.batch();
  q.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit().catch(() => {});
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
    // best-effort
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
    if (role !== "provider") {
      return res.status(403).json({ error: "Only providers can end recurring service." });
    }

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

    const isRecurring = Boolean(job.isRecurringRequest ?? job.isRecurring ?? false);
    if (!isRecurring) return res.status(400).json({ error: "Not a recurring job." });

    const providerUid = String(job.selectedProviderUid ?? "").trim();
    if (!providerUid || providerUid !== callerUid) {
      return res.status(403).json({ error: "You are not assigned to this job." });
    }

    const clientId = String(job.clientId ?? "").trim();

    // 4) Remove all future time blocks for this recurring job (best-effort)
    await deleteAllTimeBlocks(db, providerUid, jobRequestId);

    // 5) Update status + mark recurrence ended
    await jobRef.set(
      {
        status: "provider_ended_recurring",
        recurrence: {
          ...(job.recurrence ?? {}),
          endedBy: "provider",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 6) Notify client + route them to the correct job details/manage screen
    if (clientId) {
      await notifyToTopic(`user_${clientId}`, {
        type: "client_recurring_provider_ended",
        jobId: jobRequestId,
        route: "/updated_job_details_client",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("provider-end recurring error:", err);
    return res.status(500).json({
      error: "Failed to end recurring service.",
      code: err?.code,
      message: err?.message,
    });
  }
}
