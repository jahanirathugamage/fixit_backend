// pages/api/job-respond.ts
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

type Body = {
  jobId?: unknown;
  status?: unknown; // accepted | declined
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
    const status = asString(body.status).trim().toLowerCase();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (status !== "accepted" && status !== "declined") {
      return res.status(400).json({ error: "status must be accepted|declined" });
    }

    // ---- LOAD JOB ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();
    const clientId = asString(job["clientId"]).trim();

    if (!selectedProviderUid || !clientId) {
      return res.status(400).json({ error: "Job missing selectedProviderUid/clientId" });
    }

    // Caller must be assigned provider
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not selected provider)" });
    }

    // ---- UPDATE ----
    await jobRef.set(
      {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        providerResponseAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // ---- NOTIFY CLIENT ----
    const providerName =
      asString(job["providerName"] ?? job["selectedProviderName"] ?? job["serviceProviderName"]).trim() ||
      "Your service provider";

    if (status === "accepted") {
      await sendToUserTopic({
        userUid: clientId,
        title: "Job Accepted",
        body: `${providerName} accepted your job request.`,
        data: {
          route: "/dashboards/client/client_jobs",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    } else {
      await sendToUserTopic({
        userUid: clientId,
        title: "Job Declined",
        body: `${providerName} declined your job request.`,
        data: {
          route: "/dashboards/client/client_job_requests",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
