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

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

type Body = { jobId?: unknown };

type InvoicePricing = {
  totalAmount?: unknown;
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
    const jobRef = db.collection("jobRequest").doc(jobId);

    const paymentDocId = `${jobId}_final_payment`;
    const paymentRef = db.collection("payments").doc(paymentDocId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { code: 404 as const, payload: { error: "Job not found" } };

      const job = snap.data() ?? {};
      const providerUid = asString(job["selectedProviderUid"]).trim();
      const clientId = asString(job["clientId"]).trim();
      const status = asString(job["status"]).trim().toLowerCase();

      if (!providerUid || !clientId) {
        return {
          code: 400 as const,
          payload: { error: "Job missing selectedProviderUid/clientId" },
        };
      }
      if (providerUid !== callerUid) {
        return { code: 403 as const, payload: { error: "Not allowed (not selected provider)" } };
      }

      // ✅ Idempotent
      const alreadyConfirmed = !!job["finalPaymentConfirmedAt"] || status === "completed";
      if (alreadyConfirmed) {
        return {
          code: 200 as const,
          payload: { ok: true, paymentId: paymentDocId, idempotent: true },
        };
      }

      // ✅ Accept BOTH for backwards compatibility:
      // - Old flow: completed_pending_payment
      // - New flow: awaiting_final_payment_confirmation
      const allowed =
        status === "awaiting_final_payment_confirmation" || status === "completed_pending_payment";

      if (!allowed) {
        return {
          code: 400 as const,
          payload: { error: "Job is not awaiting final payment confirmation" },
        };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      // ✅ Find latest invoice for this job (if any) and mark it confirmed
      const invoiceQuery = db
        .collection("invoices")
        .where("jobId", "==", jobId)
        .orderBy("createdAt", "desc")
        .limit(1);

      const invoiceSnap = await tx.get(invoiceQuery);

      let latestInvoiceId = "";
      let finalAmount = 0;

      if (!invoiceSnap.empty) {
        const doc = invoiceSnap.docs[0];
        latestInvoiceId = doc.id;

        const inv = doc.data() ?? {};
        const rawPricing = inv["pricing"];

        let pricing: InvoicePricing = {};
        if (isRecord(rawPricing)) pricing = rawPricing as InvoicePricing;

        finalAmount = asNumber(pricing.totalAmount);

        tx.set(
          db.collection("invoices").doc(latestInvoiceId),
          {
            status: "paid_confirmed_by_provider",
            providerConfirmedAt: now,
            updatedAt: now,
          },
          { merge: true }
        );
      }

      // ✅ Update job status to COMPLETED (do NOT hide it here)
      tx.set(
        jobRef,
        {
          status: "completed",
          finalPaymentConfirmedAt: now,
          updatedAt: now,
          latestInvoiceId: latestInvoiceId || asString(job["latestInvoiceId"]).trim(),
        },
        { merge: true }
      );

      // ✅ Deterministic payment doc (prevents duplicates)
      tx.set(
        paymentRef,
        {
          type: "final_payment",
          status: "paid_confirmed",
          currency: "LKR",

          jobRequestId: jobId,
          clientId,
          providerUid,

          amountLkr: finalAmount, // best-effort from invoice.pricing.totalAmount
          invoiceId: latestInvoiceId,

          confirmedByProviderAt: now,
          createdAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      return {
        code: 200 as const,
        payload: { ok: true, paymentId: paymentDocId, invoiceId: latestInvoiceId },
      };
    });

    if (result.code !== 200) return res.status(result.code).json(result.payload);

    // Notify client (optional)
    try {
      const snap = await jobRef.get();
      const job = snap.data() ?? {};
      const clientId = asString(job["clientId"]).trim();

      if (clientId) {
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
      }
    } catch {
      // ignore notification failures
    }

    return res.status(200).json(result.payload);
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
