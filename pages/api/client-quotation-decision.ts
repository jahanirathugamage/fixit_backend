// pages/api/client-quotation-decision.ts

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

function asBool(v: unknown): boolean {
  if (v === true) return true;
  const s = asString(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function asInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function sendToUserTopic(params: {
  userUid: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}) {
  const topic = `user_${params.userUid}`;
  await admin.messaging().send({
    topic,
    notification: { title: params.title, body: params.body },
    data: params.data ?? {},
    android: { priority: "high" },
  });
}

type Body = {
  jobId?: unknown;
  decision?: unknown; // accepted | declined
  clientVisitationConfirmed?: unknown; // required when declined
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
    const decision = asString(body.decision).trim().toLowerCase(); // accepted|declined
    const clientVisitationConfirmed = asBool(body.clientVisitationConfirmed);

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (decision !== "accepted" && decision !== "declined") {
      return res.status(400).json({ error: "decision must be accepted|declined" });
    }

    const db = admin.firestore();

    const jobRef = db.collection("jobRequest").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Job not found" });

    const job = snap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const providerUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !providerUid) {
      return res.status(400).json({ error: "Job missing clientId/selectedProviderUid" });
    }

    if (clientId !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not job client)" });
    }

    // ---- Load quotation reliably (NO composite index required) ----
    let contractorId = "";
    let quotationId = asString(job["quotationId"]).trim();

    let qPricing: Record<string, unknown> | null = null;
    let qTasks: unknown[] | null = null;

    // 1) If job has quotationId, fetch directly (best + no index)
    if (quotationId) {
      try {
        const qDoc = await db.collection("quotations").doc(quotationId).get();
        if (qDoc.exists) {
          const qData = qDoc.data() ?? {};
          contractorId = asString(qData["contractorId"]).trim();

          const pricingMaybe = qData["pricing"];
          if (pricingMaybe && typeof pricingMaybe === "object") {
            qPricing = pricingMaybe as Record<string, unknown>;
          }

          const tasksMaybe = qData["tasks"];
          if (Array.isArray(tasksMaybe)) {
            qTasks = tasksMaybe as unknown[];
          }
        }
      } catch {
        // ignore
      }
    }

    // 2) Fallback: query by jobId WITHOUT orderBy (no index)
    if (!qTasks || !qPricing || !contractorId || !quotationId) {
      try {
        const qSnap = await db.collection("quotations").where("jobId", "==", jobId).limit(1).get();

        if (!qSnap.empty) {
          const qDoc = qSnap.docs[0];
          quotationId = quotationId || qDoc.id;

          const qData = qDoc.data() ?? {};
          contractorId = contractorId || asString(qData["contractorId"]).trim();

          const pricingMaybe = qData["pricing"];
          if (!qPricing && pricingMaybe && typeof pricingMaybe === "object") {
            qPricing = pricingMaybe as Record<string, unknown>;
          }

          const tasksMaybe = qData["tasks"];
          if (!qTasks && Array.isArray(tasksMaybe)) {
            qTasks = tasksMaybe as unknown[];
          }
        }
      } catch {
        // ignore
      }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ---- ACCEPTED ----
    if (decision === "accepted") {
      const patch: Record<string, unknown> = {
        status: "quotation_accepted",
        quotationDecision: "accepted",
        quotationDecisionAt: now,
        updatedAt: now,
      };

      if (quotationId) patch["quotationId"] = quotationId;
      if (contractorId) patch["contractorId"] = contractorId;

      // ✅ IMPORTANT: replace job tasks/pricing with quotation tasks/pricing (new truth)
      if (qPricing) patch["pricing"] = qPricing;
      if (qTasks) patch["tasks"] = qTasks;

      await jobRef.set(patch, { merge: true });

      // Notify provider + contractor (best-effort)
      try {
        await sendToUserTopic({
          userUid: providerUid,
          title: "Quotation Accepted",
          body: "Client accepted the quotation. You can proceed with the job.",
          data: {
            type: "provider_quotation_accepted",
            route: "/provider/job_details",
            jobId,
            quotationId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        });
      } catch {}

      if (contractorId) {
        try {
          await sendToUserTopic({
            userUid: contractorId,
            title: "Quotation Accepted",
            body: "Client accepted the quotation.",
            data: {
              type: "contractor_quotation_accepted",
              route: "/dashboards/contractor/contractor_jobs_screen",
              jobId,
              quotationId,
              click_action: "FLUTTER_NOTIFICATION_CLICK",
            },
          });
        } catch {}
      }

      return res.status(200).json({ ok: true, quotationId });
    }

    // ---- DECLINED ----
    // ✅ require client confirmation flag from app (fixes lint + correct behavior)
    if (!clientVisitationConfirmed) {
      return res.status(400).json({ error: "clientVisitationConfirmed must be true when declining" });
    }

    const jobPricing =
      (job["pricing"] && typeof job["pricing"] === "object"
        ? (job["pricing"] as Record<string, unknown>)
        : {}) as Record<string, unknown>;

    const fromJob = asInt(jobPricing["visitationFee"] ?? job["visitationFeeLkr"]);
    const fromQuotation = qPricing ? asInt(qPricing["visitationFee"]) : 0;
    const visitationFee = fromQuotation > 0 ? fromQuotation : fromJob;

    const paymentId = quotationId ? `visitation_${jobId}_${quotationId}` : `visitation_${jobId}`;
    const paymentRef = db.collection("payments").doc(paymentId);

    await db.runTransaction(async (tx) => {
      tx.set(
        jobRef,
        {
          status: "quotation_declined_pending_visitation",
          quotationDecision: "declined",
          quotationDecisionAt: now,
          updatedAt: now,
          ...(quotationId ? { quotationId } : {}),
          ...(contractorId ? { contractorId } : {}),
          clientVisitationConfirmed: true,
          clientVisitationConfirmedAt: now,
        },
        { merge: true }
      );

      tx.set(
        paymentRef,
        {
          type: "visitation",
          status: "pending_provider_confirmation",
          jobId,
          quotationId: quotationId || null,
          invoiceId: null,
          clientId,
          providerUid,
          contractorId: contractorId || null,
          currency: "LKR",
          amount: visitationFee,
          clientConfirmedAt: now,
          providerConfirmedAt: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: now,
        },
        { merge: true }
      );
    });

    try {
      await sendToUserTopic({
        userUid: providerUid,
        title: "Visitation Fee",
        body: "Client declined the quotation. Please confirm visitation fee received.",
        data: {
          type: "provider_confirm_visitation_fee",
          route: "/provider/confirm_visitation_fee",
          jobId,
          quotationId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    } catch {}

    if (contractorId) {
      try {
        await sendToUserTopic({
          userUid: contractorId,
          title: "Quotation Declined",
          body: "Client declined the quotation.",
          data: {
            type: "contractor_quotation_declined",
            route: "/dashboards/contractor/contractor_jobs_screen",
            jobId,
            quotationId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        });
      } catch {}
    }

    return res.status(200).json({ ok: true, quotationId, paymentId });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
