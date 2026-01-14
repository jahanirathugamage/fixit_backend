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

type InvoiceCreateBody = {
  jobId?: unknown;
  note?: unknown;
  invoiceImageUrl?: unknown;
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
    const note = asString(body.note).trim();
    const invoiceImageUrl = asString(body.invoiceImageUrl).trim();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (!invoiceImageUrl) return res.status(400).json({ error: "invoiceImageUrl is required" });

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

    // ✅ Store invoice doc (client screen reads this)
    await db.collection("invoices").add({
      jobId,
      contractorId: callerUid,
      note,
      invoiceImageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "sent",
    });

    // ✅ Notify client
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

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
