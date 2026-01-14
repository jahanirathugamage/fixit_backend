// pages/api/visitation-confirm.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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
    notification: {
      title: params.title,
      body: params.body,
    },
    data: params.data ?? {},
    android: { priority: "high" },
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ---------------- AUTH ----------------
    const authHeader = req.headers.authorization ?? "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    // ---------------- INPUT ----------------
    const jobId = asString(req.body?.jobId);
    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }

    // ---------------- LOAD JOB ----------------
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = snap.data() ?? {};
    const selectedProviderUid = asString(job.selectedProviderUid);
    const clientId = asString(job.clientId);
    const contractorId = asString(job.contractorId);

    if (!selectedProviderUid || !clientId) {
      return res
        .status(400)
        .json({ error: "Job missing provider or client reference" });
    }

    // ---------------- AUTHZ ----------------
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({
        error: "Only the assigned service provider can confirm visitation fee",
      });
    }

    if (job.status !== "quotation_declined_pending_visitation") {
      return res.status(400).json({
        error: "Job is not awaiting visitation fee confirmation",
      });
    }

    // ---------------- WRITE PAYMENT ----------------
    const paymentRef = admin.firestore().collection("payments").doc();

    const visitationFee = Number(job.visitationFee ?? 250);

    await paymentRef.set({
      jobRequestId: jobId,
      clientId,
      contractorId: contractorId || null,
      providerUid: selectedProviderUid,
      amount: visitationFee,
      type: "visitation_fee",
      currency: "LKR",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ---------------- TERMINATE JOB ----------------
    await jobRef.update({
      status: "terminated",
      visitationFeeConfirmedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ---------------- NOTIFY CLIENT ----------------
    await sendToUserTopic({
      userUid: clientId,
      title: "Visitation Fee Confirmed",
      body:
        "The service provider has confirmed receipt of the visitation fee. The job has been closed.",
      data: {
        route: "/dashboards/client/client_jobs",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    // ---------------- NOTIFY CONTRACTOR ----------------
    if (contractorId) {
      await sendToUserTopic({
        userUid: contractorId,
        title: "Job Closed",
        body:
          "The client declined the quotation and the visitation fee has been confirmed.",
        data: {
          route: "/dashboards/contractor/contractor_jobs",
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
