// pages/api/recurring/client-cancel-next.ts
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

function parseFrequencyToDelta(freqRaw: string): { unit: "week" | "month"; value: number } | null {
  const s = (freqRaw || "").toString().trim().toLowerCase();
  if (!s) return null;

  const cleaned = s.startsWith("every ") ? s.slice(6).trim() : s;
  const m = cleaned.match(/^(\d+)\s*(week|weeks|month|months)$/i);
  if (!m) return null;

  const value = Math.max(1, parseInt(m[1], 10) || 1);
  const unitRaw = m[2].toLowerCase();
  const unit = unitRaw.startsWith("week") ? "week" : "month";
  return { unit, value };
}

function addWeeks(d: Date, weeks: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + weeks * 7);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const y = out.getUTCFullYear();
  const m = out.getUTCMonth();
  const day = out.getUTCDate();

  const targetMonth = m + months;
  out.setUTCFullYear(y, targetMonth, 1);

  // clamp day
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));

  return out;
}

async function deleteTimeBlocksForThisOccurrence(db: FirebaseFirestore.Firestore, providerUid: string, jobId: string, scheduledAt: Date) {
  // Best-effort: delete blocks in provider/timeBlocks that match this jobId and occurrence start timestamp
  const col = db.collection("serviceProviders").doc(providerUid).collection("timeBlocks");

  const start = admin.firestore.Timestamp.fromDate(scheduledAt);
  const q = await col
    .where("jobId", "==", jobId)
    .where("startAt", "==", start)
    .get()
    .catch(() => null);

  if (!q || q.empty) return;

  const batch = db.batch();
  q.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit().catch(() => {});
}

async function notifyToTopic(topic: string, payload: any) {
  try {
    await admin.messaging().send({
      topic,
      data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    });
  } catch (_) {
    // ignore notify errors
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
    if (role !== "client") return res.status(403).json({ error: "Only clients can cancel next job." });

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

    const clientId = String(job.clientId ?? "").trim();
    if (!clientId || clientId !== callerUid) {
      return res.status(403).json({ error: "You do not own this job request." });
    }

    const isRecurring = Boolean(job.isRecurringRequest ?? job.isRecurring ?? false);
    if (!isRecurring) return res.status(400).json({ error: "Not a recurring job." });

    const providerUid = String(job.selectedProviderUid ?? "").trim();
    const scheduledTs = job.scheduledDate;
    const scheduledAt: Date | null = scheduledTs?.toDate ? scheduledTs.toDate() : null;

    const recurrence = (job.recurrence ?? {}) as any;
    const freqRaw = String(recurrence.frequency ?? recurrence.interval ?? "").trim();

    if (!scheduledAt) return res.status(400).json({ error: "Missing scheduledDate." });

    const delta = parseFrequencyToDelta(freqRaw);
    if (!delta) return res.status(400).json({ error: "Invalid recurrence frequency." });

    // delete current occurrence block (best-effort)
    if (providerUid) {
      await deleteTimeBlocksForThisOccurrence(db, providerUid, jobRequestId, scheduledAt);
    }

    // advance scheduledDate to next occurrence
    const nextAt =
      delta.unit === "week" ? addWeeks(scheduledAt, delta.value) : addMonths(scheduledAt, delta.value);

    await jobRef.set(
      {
        status: "accepted",
        scheduledDate: admin.firestore.Timestamp.fromDate(nextAt),
        recurrence: {
          ...recurrence,
          lastClientCancelledNextAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // notify provider (optional)
    if (providerUid) {
      await notifyToTopic(`user_${providerUid}`, {
        type: "provider_recurring_next_cancelled_by_client",
        jobId: jobRequestId,
        route: "/provider/recurring_job_details",
      });
    }

    return res.status(200).json({ ok: true, nextScheduledAt: nextAt.toISOString() });
  } catch (err: any) {
    console.error("client-cancel-next error:", err);
    return res.status(500).json({
      error: "Failed to cancel next job.",
      code: err?.code,
      message: err?.message,
    });
  }
}
