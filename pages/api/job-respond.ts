// pages/api/job-respond.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(req: NextApiRequest, res: NextApiResponse) {
  // ✅ Reflect the origin (better than "*" for modern browser behavior)
  // If you want to lock it down later, replace with your exact web domain(s).
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  // ✅ Allow common headers Flutter Web/browser sends during preflight
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Firebase-Auth"
  );

  // Optional, but helps reduce preflight spam
  res.setHeader("Access-Control-Max-Age", "86400");
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
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", message: "Method not allowed" });
  }

  try {
    // ---- AUTH ----
    // ✅ Support both:
    // 1) Authorization: Bearer <token>
    // 2) X-Firebase-Auth: <token>
    const authHeader = asString(req.headers.authorization || "");
    const xFirebaseAuth = asString(req.headers["x-firebase-auth"] || "");

    let idToken = "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (match?.[1]) {
      idToken = match[1];
    } else if (xFirebaseAuth.trim()) {
      idToken = xFirebaseAuth.trim();
    }

    if (!idToken) {
      return res.status(401).json({ error: "Missing token", message: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    // ---- INPUT ----
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    const status = asString(body.status).trim().toLowerCase();

    if (!jobId) return res.status(400).json({ error: "jobId is required", message: "jobId is required" });
    if (status !== "accepted" && status !== "declined") {
      return res
        .status(400)
        .json({ error: "status must be accepted|declined", message: "status must be accepted|declined" });
    }

    // ---- LOAD JOB ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found", message: "Job not found" });

    const job = snap.data() ?? {};
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();
    const clientId = asString(job["clientId"]).trim();

    if (!selectedProviderUid || !clientId) {
      return res
        .status(400)
        .json({ error: "Job missing selectedProviderUid/clientId", message: "Job missing selectedProviderUid/clientId" });
    }

    // Caller must be assigned provider
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({
        error: "Not allowed (not selected provider)",
        message: "Not allowed (not selected provider)",
      });
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
        title: "Booking Confirmed",
        body: `${providerName} accepted your job request.`,
        data: {
          type: "client_job_accepted",
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
          type: "client_job_declined",
          route: "/dashboards/client/client_job_requests",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    return res.status(500).json({ error: msg, message: msg });
  }
}
