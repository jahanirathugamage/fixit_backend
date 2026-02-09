// pages/api/job-respond.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

type ApiError = { error: string; message?: string };
type ApiOk = { ok: true };

function setCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Firebase-Auth"
  );
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
  await admin.messaging().send({
    topic: `user_${params.userUid}`,
    notification: { title: params.title, body: params.body },
    data: params.data ?? {},
    android: { priority: "high" },
  });
}

type Body = {
  jobId?: unknown;
  status?: unknown; // accepted | declined
};

// ✅ Minimal shape we read from timeBlocks docs (no `any`)
type TimeBlockDoc = {
  status?: unknown;
  holdExpiresAt?: unknown;
};

function isTimestamp(v: unknown): v is admin.firestore.Timestamp {
  return typeof v === "object" && v !== null && typeof (v as { toDate?: unknown }).toDate === "function";
}

async function finalizeOrReleaseHolds(params: {
  providerUid: string;
  jobId: string;
  decision: "accepted" | "declined";
}) {
  const db = admin.firestore();
  const blocksRef = db
    .collection("serviceProviders")
    .doc(params.providerUid)
    .collection("timeBlocks");

  // Fetch all blocks for this job
  const qs = await blocksRef.where("jobId", "==", params.jobId).get();
  if (qs.empty) return;

  const batch = db.batch();
  const now = admin.firestore.Timestamp.now();

  for (const d of qs.docs) {
    const data = d.data() as TimeBlockDoc;
    const currentStatus = asString(data.status).trim().toLowerCase();

    // Only touch blocks created for this job
    if (currentStatus !== "held" && currentStatus !== "booked") continue;

    // If it's a held block but already expired, delete it regardless
    if (currentStatus === "held") {
      const exp = data.holdExpiresAt;
      if (isTimestamp(exp) && exp.toMillis() < now.toMillis()) {
        batch.delete(d.ref);
        continue;
      }
    }

    if (params.decision === "accepted") {
      // ✅ Convert held -> booked (leave booked as booked)
      batch.set(
        d.ref,
        {
          status: "booked",
          bookedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      // ✅ Declined -> delete blocks (free availability)
      batch.delete(d.ref);
    }
  }

  await batch.commit();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiOk | ApiError>
) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", message: "Method not allowed" });
  }

  try {
    // ---- AUTH ----
    // Supports:
    // 1) Authorization: Bearer <token>
    // 2) X-Firebase-Auth: <token>
    const authHeader = asString(req.headers.authorization || "");
    const xFirebaseAuth = asString(req.headers["x-firebase-auth"] || "");

    let idToken = "";
    const m = authHeader.match(/^Bearer (.+)$/);
    if (m?.[1]) idToken = m[1];
    else if (xFirebaseAuth.trim()) idToken = xFirebaseAuth.trim();

    if (!idToken) {
      return res.status(401).json({ error: "Missing token", message: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    // ---- INPUT ----
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    const status = asString(body.status).trim().toLowerCase();

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required", message: "jobId is required" });
    }

    if (status !== "accepted" && status !== "declined") {
      return res.status(400).json({
        error: "status must be accepted|declined",
        message: "status must be accepted|declined",
      });
    }

    // ---- LOAD JOB ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Job not found", message: "Job not found" });
    }

    const job = snap.data() ?? {};
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();
    const clientId = asString(job["clientId"]).trim();

    if (!selectedProviderUid || !clientId) {
      return res.status(400).json({
        error: "Job missing selectedProviderUid/clientId",
        message: "Job missing selectedProviderUid/clientId",
      });
    }

    // Caller must be assigned provider
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({
        error: "Not allowed (not selected provider)",
        message: "Not allowed (not selected provider)",
      });
    }

    const isRecurring =
      Boolean(job["isRecurring"]) || Boolean(job["isRecurringRequest"]);

    const providerName =
      asString(
        job["providerName"] ??
          job["selectedProviderName"] ??
          job["serviceProviderName"]
      ).trim() || "Your service provider";

    // ---- UPDATE JOB ----
    await jobRef.set(
      {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        providerResponseAt: admin.firestore.FieldValue.serverTimestamp(),

        ...(isRecurring
          ? {
              recurrenceSeriesId: asString(job["recurrenceSeriesId"]).trim() || jobId,
              recurrenceIndex: Number.isFinite(Number(job["recurrenceIndex"]))
                ? Number(job["recurrenceIndex"])
                : 0,
            }
          : {}),
      },
      { merge: true }
    );

    // ---- HOLDS ----
    await finalizeOrReleaseHolds({
      providerUid: callerUid,
      jobId,
      decision: status as "accepted" | "declined",
    });

    // ---- NOTIFY CLIENT ----
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
