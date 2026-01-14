// pages/api/confirm-visitation-fee.ts
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

function asInt(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return fallback;
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
};

function contractorIdFromManagedBy(managedBy: unknown): string {
  // managedBy is expected to be a DocumentReference like /contractors/{id}
  // Firestore Admin returns a DocumentReference object with .path
  try {
    const ref = managedBy as { path?: unknown };
    const path = asString(ref?.path).trim(); // "contractors/{id}"
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] === "contractors") return parts[1];
  } catch {
    // ignore
  }
  return "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ---------------- AUTH ----------------
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    // ---------------- INPUT ----------------
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    // ---------------- LOAD JOB ----------------
    const db = admin.firestore();
    const jobRef = db.collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const status = asString(job["status"]).trim().toLowerCase();

    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();
    const clientId = asString(job["clientId"]).trim();

    if (!selectedProviderUid || !clientId) {
      return res.status(400).json({ error: "Job missing selectedProviderUid/clientId" });
    }

    // provider must be assigned provider
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not selected provider)" });
    }

    // must be in correct state
    // NOTE: Your earlier endpoint sets: "awaiting_visitation_fee_confirmation"
    if (status !== "awaiting_visitation_fee_confirmation") {
      return res.status(400).json({ error: "Job is not awaiting visitation fee confirmation" });
    }

    // ---------------- READ VISITATION FEE ----------------
    // priority:
    // 1) job.pricing.visitationFee
    // 2) job.visitationFee
    // 3) fallback 250
    const pricing = isRecord(job["pricing"]) ? (job["pricing"] as Record<string, unknown>) : {};
    const visitationFee = asInt(pricing["visitationFee"], asInt(job["visitationFee"], 250));

    // ---------------- GET CONTRACTOR (via serviceProviders.managedBy) ----------------
    let contractorId = "";
    try {
      const providerDoc = await db.collection("serviceProviders").doc(selectedProviderUid).get();
      if (providerDoc.exists) {
        const pdata = providerDoc.data() ?? {};
        contractorId = contractorIdFromManagedBy(pdata["managedBy"]);
        if (!contractorId) contractorId = asString(pdata["contractorId"]).trim();
      }
    } catch {
      // ignore
    }

    // ---------------- CREATE PAYMENT ----------------
    const category = asString(job["category"]).trim();
    const scheduledDate = job["scheduledDate"] ?? null;

    const paymentRef = db.collection("payments").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Use a batch so payment + job state changes are atomic
    const batch = db.batch();

    batch.set(paymentRef, {
      type: "visitation_fee",
      status: "paid_confirmed",
      amount: visitationFee,
      currency: "LKR",

      jobRequestId: jobId,
      clientId,
      providerUid: selectedProviderUid,
      contractorId: contractorId || null,

      category: category || null,
      scheduledDate,

      confirmedByProviderAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // ---------------- TERMINATE / HIDE JOB ----------------
    batch.set(
      jobRef,
      {
        status: "terminated_after_quotation_decline",
        terminatedAt: now,
        visitationFeeConfirmedAt: now,
        paymentId: paymentRef.id,
        updatedAt: now,
      },
      { merge: true }
    );

    await batch.commit();

    // ---------------- NOTIFICATIONS ----------------
    // Client
    await sendToUserTopic({
      userUid: clientId,
      title: "Job Closed",
      body: "Thank you for using FixIt, we are happy to serve you.",
      data: {
        route: "/dashboards/client/client_jobs",
        jobId,
        type: "visitation_fee_confirmed",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    // Contractor (optional)
    if (contractorId) {
      await sendToUserTopic({
        userUid: contractorId,
        title: "Job Closed",
        body: "Visitation fee was confirmed. The job has been closed.",
        data: {
          route: "/dashboards/contractor/contractor_jobs_screen",
          jobId,
          type: "job_closed",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    }

    // Provider
    await sendToUserTopic({
      userUid: selectedProviderUid,
      title: "Job Closed",
      body: "Payment confirmed. This job has been closed.",
      data: {
        route: "/settings",
        jobId,
        type: "job_closed",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    return res.status(200).json({ ok: true, paymentId: paymentRef.id });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
