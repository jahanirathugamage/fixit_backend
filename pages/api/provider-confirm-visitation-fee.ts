// pages/api/provider-confirm-visitation-fee.ts
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

type Body = {
  jobId?: unknown;
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
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const db = admin.firestore();

    // ---- LOAD JOB ----
    const jobRef = db.collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const providerUid = asString(job["selectedProviderUid"]).trim();
    const clientId = asString(job["clientId"]).trim();
    const status = asString(job["status"]).trim().toLowerCase();

    if (!providerUid || !clientId) {
      return res.status(400).json({ error: "Job missing selectedProviderUid/clientId" });
    }

    // Caller must be assigned provider
    if (providerUid !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not selected provider)" });
    }

    // Optional: enforce correct state (matches your earlier flow file)
    const allowedStates = new Set([
      "awaiting_visitation_fee_confirmation",
      "quotation_declined_pending_visitation",
      "awaiting_visitation_confirmation",
    ]);

    if (status && !allowedStates.has(status)) {
      return res.status(400).json({ error: "Job is not awaiting visitation fee confirmation" });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ---- UPDATE JOB (closed/hidden) ----
    // Use your normalized status from the confirm-visitation-fee endpoint.
    await jobRef.set(
      {
        status: "terminated_after_quotation_decline",
        terminatedAt: now,
        visitationFeeConfirmedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // ---- CREATE PAYMENT RECORD (minimal) ----
    await db.collection("payments").add({
      type: "visitation_fee",
      status: "paid_confirmed",
      currency: "LKR",
      jobRequestId: jobId,
      clientId,
      providerUid,
      confirmedByProviderAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // ---- NOTIFY CLIENT ----
    await admin.messaging().send({
      topic: `user_${clientId}`,
      notification: {
        title: "Job Closed",
        body: "Thank you for using FixIt, we are happy to serve you.",
      },
      data: {
        type: "client_job_terminated_after_decline",
        route: "/dashboards/client/client_job_requests",
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
