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

type Body = { jobId?: unknown };

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
    const jobRef = db.collection("jobRequest").doc(jobId);

    const paymentDocId = `${jobId}_visitation_fee`;
    const paymentRef = db.collection("payments").doc(paymentDocId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { code: 404 as const, payload: { error: "Job not found" } };

      const job = snap.data() ?? {};
      const providerUid = asString(job["selectedProviderUid"]).trim();
      const clientId = asString(job["clientId"]).trim();
      const status = asString(job["status"]).trim().toLowerCase();

      if (!providerUid || !clientId) {
        return { code: 400 as const, payload: { error: "Job missing selectedProviderUid/clientId" } };
      }
      if (providerUid !== callerUid) {
        return { code: 403 as const, payload: { error: "Not allowed (not selected provider)" } };
      }

      // ✅ Allow all the “declined → visitation confirm” variants you use
      const allowedStates = new Set([
        "awaiting_visitation_fee_confirmation",
        "quotation_declined_pending_visitation",
        "awaiting_visitation_confirmation",
      ]);

      // ✅ Idempotent: if already confirmed/terminated, return ok
      const alreadyConfirmed = !!job["visitationFeeConfirmedAt"] || status === "terminated_after_quotation_decline";
      if (alreadyConfirmed) {
        return { code: 200 as const, payload: { ok: true, paymentId: paymentDocId, idempotent: true } };
      }

      if (status && !allowedStates.has(status)) {
        return { code: 400 as const, payload: { error: "Job is not awaiting visitation fee confirmation" } };
      }

      // ✅ Dual-confirm requirement: client must confirm first
      const clientConfirmedAt = job["clientVisitationConfirmedAt"];
      const hasClientConfirm = !!clientConfirmedAt;
      if (!hasClientConfirm) {
        return {
          code: 400 as const,
          payload: { error: "Client has not confirmed visitation payment yet." },
        };
      }

      const pricing = isRecord(job["pricing"]) ? (job["pricing"] as Record<string, unknown>) : {};
      const visitationFee = asInt(pricing["visitationFee"], asInt(job["visitationFee"], 250));

      // ✅ Get latest quotationId for linking payment (optional)
      let quotationId = "";
      try {
        const qQuery = db
          .collection("quotations")
          .where("jobId", "==", jobId)
          .orderBy("createdAt", "desc")
          .limit(1);
        const qSnap = await tx.get(qQuery);
        if (!qSnap.empty) quotationId = qSnap.docs[0].id;
      } catch {
        // ignore
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      // ✅ Create/merge deterministic payment doc (prevents duplicates)
      tx.set(
        paymentRef,
        {
          type: "visitation_fee",
          status: "paid_confirmed",
          currency: "LKR",
          amount: visitationFee,

          jobRequestId: jobId,
          quotationId: quotationId || null,

          clientId,
          providerUid,

          clientConfirmedAt: clientConfirmedAt ?? null,
          confirmedByProviderAt: now,
          createdAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      // ✅ Close job ONLY after both confirmations
      tx.set(
        jobRef,
        {
          status: "terminated_after_quotation_decline",
          terminatedAt: now,
          visitationFeeConfirmedAt: now,
          providerVisitationConfirmedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      return { code: 200 as const, payload: { ok: true, paymentId: paymentDocId, quotationId } };
    });

    if (result.code !== 200) return res.status(result.code).json(result.payload);

    // Notify client (outside transaction)
    try {
      const jobSnap = await jobRef.get();
      const job = jobSnap.data() ?? {};
      const clientId = asString(job["clientId"]).trim();

      if (clientId) {
        await sendToUserTopic({
          userUid: clientId,
          title: "Job Closed",
          body: "Thank you for using FixIt, we are happy to serve you.",
          data: {
            type: "visitation_fee_confirmed",
            // ✅ go home so you can show Image 5 sheet there
            route: "/dashboards/client/home_client",
            jobId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        });
      }
    } catch {
      // ignore
    }

    return res.status(200).json(result.payload);
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
