// pages/api/job-request-notify.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function sendToUserTopic(params: {
  userUid: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}) {
  const topic = `user_${params.userUid}`;
  await admin.messaging().send({
    topic,
    notification: { title: params.title, body: params.body },
    data: params.data ?? {},
    android: { priority: "high" },
  });
}

// Simple lock to avoid duplicates if client retries
async function acquireLock(lockId: string): Promise<boolean> {
  const ref = admin.firestore().collection("notificationLocks").doc(lockId);
  try {
    await ref.create({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(lockId: string): Promise<void> {
  try {
    await admin.firestore().collection("notificationLocks").doc(lockId).delete();
  } catch {
    // ignore
  }
}

type Body = {
  jobId?: unknown;
  providerUid?: unknown;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ---- AUTH ----
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    // ---- INPUT ----
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    const providerUid = asString(body.providerUid).trim();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (!providerUid) return res.status(400).json({ error: "providerUid is required" });

    // ---- LOAD JOB ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const status = asString(job["status"]).trim().toLowerCase();

    if (!clientId) return res.status(400).json({ error: "Job missing clientId" });

    // Caller must be the client of this job
    if (clientId !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not client)" });
    }

    // Optional: only notify when it's in request state
    const allowed = ["requested", "holding", "pending"];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `Job status not notifiable: ${status}` });
    }

    // ---- DEDUPE LOCK ----
    const lockId = `${jobId}_request_to_${providerUid}`;
    const locked = await acquireLock(lockId);
    if (!locked) return res.status(200).json({ ok: true, deduped: true });

    // ---- MESSAGE ----
    const clientName = asString(job["clientName"]).trim() || "A client";
    const category = asString(job["category"]).trim();
    const bodyText = category ? `${clientName} requested ${category}.` : `${clientName} sent you a job request.`;

    try {
      await sendToUserTopic({
        userUid: providerUid,
        title: "New Job Request",
        body: bodyText,
        data: {
          route: "/provider/job_details",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });

      // Mark sent on doc (optional)
      await jobRef.set(
        { notifications: { requestSentAt: admin.firestore.FieldValue.serverTimestamp() } },
        { merge: true }
      );

      return res.status(200).json({ ok: true });
    } catch (e) {
      await releaseLock(lockId);
      throw e;
    }
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
