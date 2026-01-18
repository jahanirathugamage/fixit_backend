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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

function extractContractorIdFromRef(refLike: unknown): string {
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

type Body = {
  jobId?: unknown;

  // ✅ now required (so backend creates the quotation doc)
  pricing?: unknown; // { platformFee, serviceTotal, totalAmount, visitationFee }
  tasks?: unknown;   // [{ label, lineTotal, quantity, unitPrice }, ...]
};

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
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    if (!isRecord(body.pricing)) return res.status(400).json({ error: "pricing is required" });
    if (!Array.isArray(body.tasks)) return res.status(400).json({ error: "tasks is required" });

    const pricing = body.pricing as Record<string, unknown>;
    const tasks = body.tasks as Array<unknown>;

    // basic task validation
    const mappedTasks = tasks.map((t) => (isRecord(t) ? t : {}));
    if (mappedTasks.length === 0) {
      return res.status(400).json({ error: "tasks must have at least 1 item" });
    }

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

    const managedBy = provider["managedBy"];
    const managedContractorId = extractContractorIdFromRef(managedBy);

    const contractorIdFallback = asString(provider["contractorId"]).trim();

    const owns =
      (managedContractorId && managedContractorId === contractorUid) ||
      (contractorIdFallback && contractorIdFallback === contractorUid);

    if (!owns) return res.status(403).json({ error: "Not your job" });

    // ✅ If a quotation already exists on the job, keep it idempotent
    const existingQuotationId = asString(job["quotationId"]).trim();
    if (existingQuotationId) {
      // still ensure status is correct
      await jobRef.set(
        {
          status: "quotation_created",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // best-effort notify client again (safe)
      try {
        await sendToUserTopic({
          userUid: clientId,
          title: "Quotation Ready",
          body: "A quotation has been created for your job. Tap to review it.",
          data: {
            type: "client_quotation_created",
            route: "/client/quotation",
            jobId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        });
      } catch {
        // ignore
      }

      return res.status(200).json({ ok: true, quotationId: existingQuotationId, idempotent: true });
    }

    // -------- CREATE QUOTATION DOC --------
    const quotationRef = db.collection("quotations").doc(); // auto id
    const quotationId = quotationRef.id;

    const now = admin.firestore.FieldValue.serverTimestamp();

    // write quotation + update job in one batch
    const batch = db.batch();

    batch.set(quotationRef, {
      jobId,
      contractorId: contractorUid,
      pricing,
      tasks: mappedTasks,
      createdAt: now,
      updatedAt: now,
    });

    batch.set(
      jobRef,
      {
        quotationId,
        status: "quotation_created",
        quotationCreatedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    await batch.commit();

    // -------- NOTIFY CLIENT --------
    await sendToUserTopic({
      userUid: clientId,
      title: "Quotation Ready",
      body: "A quotation has been created for your job. Tap to review it.",
      data: {
        type: "client_quotation_created",
        route: "/client/quotation",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    return res.status(200).json({ ok: true, quotationId });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
