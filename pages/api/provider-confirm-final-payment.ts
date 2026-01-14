// pages/api/provider-confirm-final-payment.ts
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

    // Optional: enforce correct state
    // Client marks invoice paid -> "completed_pending_payment" in your client-mark-invoice-paid.ts
    if (status && status !== "completed_pending_payment") {
      return res.status(400).json({ error: "Job is not awaiting final payment confirmation" });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ---- UPDATE JOB (completed + hidden) ----
    await jobRef.set(
      {
        status: "completed_hidden",
        finalPaymentConfirmedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // ---- PAYMENT RECORD ----
    await db.collection("payments").add({
      type: "final_payment",
      status: "paid_confirmed",
      currency: "LKR",
      jobRequestId: jobId,
      clientId,
      providerUid,
      confirmedByProviderAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Optional: notify client that job is completed (safe to keep minimal)
    await admin.messaging().send({
      topic: `user_${clientId}`,
      notification: {
        title: "Job Completed",
        body: "Thank you for using FixIt, we are happy to serve you.",
      },
      data: {
        type: "client_job_completed",
        route: "/dashboards/client/client_jobs",
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
