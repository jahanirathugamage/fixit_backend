// pages/api/invoice-create.ts
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

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

type InvoiceLine = {
  label?: unknown;
  unitPrice?: unknown;
  quantity?: unknown;
  lineTotal?: unknown;
};

type InvoicePricing = {
  serviceTotal?: unknown;
  materialCost?: unknown;
  visitationFee?: unknown;
  platformFee?: unknown;
  totalAmount?: unknown;
};

type InvoiceCreateBody = {
  jobId?: unknown;
  lines?: unknown;
  pricing?: unknown;
  materialInvoiceImageUrl?: unknown;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    const body = (req.body ?? {}) as InvoiceCreateBody;

    const jobId = asString(body.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const rawLines = Array.isArray(body.lines) ? (body.lines as InvoiceLine[]) : [];
    if (rawLines.length === 0) return res.status(400).json({ error: "lines are required" });

    const pricing =
      body.pricing && typeof body.pricing === "object"
        ? (body.pricing as InvoicePricing)
        : {};

    const materialInvoiceImageUrl = asString(body.materialInvoiceImageUrl).trim();

    const db = admin.firestore();

    const jobRef = db.collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const providerUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !providerUid) {
      return res.status(400).json({ error: "Job missing clientId/providerUid" });
    }

    // Optional safety: if job has contractorId, enforce it
    const jobContractorId = asString(job["contractorId"]).trim();
    if (jobContractorId && jobContractorId !== callerUid) {
      return res.status(403).json({ error: "Not allowed to create invoice for this job" });
    }

    // Normalize invoice lines
    const lines = rawLines.map((l) => {
      const label = asString(l.label).trim();
      const unitPrice = asNumber(l.unitPrice);
      const quantity = Math.max(1, Math.floor(asNumber(l.quantity)));
      const lineTotal = asNumber(l.lineTotal) || unitPrice * quantity;

      return { label, unitPrice, quantity, lineTotal };
    });

    // Normalize pricing
    const normalizedPricing = {
      serviceTotal: Math.max(0, Math.floor(asNumber(pricing.serviceTotal))),
      materialCost: Math.max(0, Math.floor(asNumber(pricing.materialCost))),
      visitationFee: Math.max(0, Math.floor(asNumber(pricing.visitationFee))),
      platformFee: Math.max(0, Math.floor(asNumber(pricing.platformFee))),
      totalAmount: Math.max(0, Math.floor(asNumber(pricing.totalAmount))),
    };

    // Create invoice doc
    const invoiceRef = await db.collection("invoices").add({
      jobId,
      contractorId: callerUid,
      lines,
      pricing: normalizedPricing,
      materialInvoiceImageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "sent",
    });

    // ✅ Update job so UI/flow can key off it
    await jobRef.set(
      {
        latestInvoiceId: invoiceRef.id,
        invoiceCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // This status is what your UPDATED job-details page uses to auto-show client payment confirmation,
        // and it’s also the right moment to tell the client “pay now”.
        status: "completed_pending_payment",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Notify client
    await admin.messaging().send({
      topic: `user_${clientId}`,
      notification: { title: "Invoice Ready", body: "The invoice is available for your job." },
      data: {
        type: "client_invoice_created",
        route: "/client/invoice_review",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      android: { priority: "high" },
    });

    return res.status(200).json({ ok: true, invoiceId: invoiceRef.id });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
