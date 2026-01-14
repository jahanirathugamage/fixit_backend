// pages/api/quotation-create.ts
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

type QuotationCreateBody = {
  jobId?: unknown;
};

function extractContractorIdFromRef(refLike: unknown): string {
  // supports Firestore DocumentReference objects (have .path) or strings
  try {
    if (typeof refLike === "string") {
      const parts = refLike.split("/").filter(Boolean);
      if (parts.length === 2 && parts[0] === "contractors") return parts[1];
      return "";
    }
    const maybe = refLike as { path?: unknown };
    const path = asString(maybe?.path).trim(); // "contractors/{id}"
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
    // -------- AUTH --------
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const contractorUid = decoded.uid;

    // -------- INPUT --------
    const body = (req.body ?? {}) as QuotationCreateBody;
    const jobId = asString(body.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    const db = admin.firestore();

    // -------- LOAD JOB --------
    const jobRef = db.collection("jobRequest").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job not found" });

    const job = jobSnap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const providerUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !providerUid) {
      return res.status(400).json({ error: "Job missing client/provider" });
    }

    // -------- VERIFY CONTRACTOR OWNS PROVIDER --------
    const providerSnap = await db.collection("serviceProviders").doc(providerUid).get();
    if (!providerSnap.exists) return res.status(403).json({ error: "Provider not found" });

    const provider = providerSnap.data() ?? {};

    // Your model: serviceProviders/{uid}.managedBy is a DocumentReference to contractors/{id}
    const managedBy = provider["managedBy"];
    const managedContractorId = extractContractorIdFromRef(managedBy);

    // fallback (some docs might store contractorId string)
    const contractorIdFallback = asString(provider["contractorId"]).trim();

    const owns =
      (managedContractorId && managedContractorId === contractorUid) ||
      (contractorIdFallback && contractorIdFallback === contractorUid);

    if (!owns) return res.status(403).json({ error: "Not your job" });

    // -------- UPDATE JOB STATUS --------
    await jobRef.set(
      {
        status: "quotation_created",
        quotationCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // -------- NOTIFY CLIENT --------
    await sendToUserTopic({
      userUid: clientId,
      title: "Quotation Ready",
      body: "A quotation has been created for your job. Please review it.",
      data: {
        type: "client_quotation_created",
        route: "/client/quotation_review",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
