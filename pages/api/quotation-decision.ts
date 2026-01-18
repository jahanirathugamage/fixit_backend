// pages/api/quotation-decision.ts
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
  decision?: unknown; // accepted | declined
};

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
    const decision = asString(body.decision).trim().toLowerCase();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (decision !== "accepted" && decision !== "declined") {
      return res.status(400).json({ error: "decision must be accepted|declined" });
    }

    // ---------------- LOAD JOB ----------------
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job not found" });

    const job = jobSnap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !selectedProviderUid) {
      return res.status(400).json({ error: "Job missing clientId/selectedProviderUid" });
    }

    // Client must own job
    if (clientId !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not client owner)" });
    }

    // ---------------- LOAD QUOTATION (by jobId) ----------------
    const qSnap = await admin
      .firestore()
      .collection("quotations")
      .where("jobId", "==", jobId)
      .limit(1)
      .get();

    if (qSnap.empty) {
      return res.status(404).json({ error: "Quotation not found for this job" });
    }

    const quotationDoc = qSnap.docs[0];
    const quotation = quotationDoc.data() ?? {};
    const contractorId = asString(quotation["contractorId"]).trim();

    const pricing = isRecord(quotation["pricing"]) ? (quotation["pricing"] as Record<string, unknown>) : {};
    const visitationFee = asInt(pricing["visitationFee"], asInt(job["visitationFee"], 250));
    const totalAmount = asInt(pricing["totalAmount"], 0);
    const platformFee = asInt(pricing["platformFee"], 0);
    const serviceTotal = asInt(pricing["serviceTotal"], 0);

    const tasksRaw = Array.isArray(quotation["tasks"]) ? (quotation["tasks"] as unknown[]) : [];
    const mappedTasks = tasksRaw.map((t) => {
      const m = (isRecord(t) ? t : {}) as Record<string, unknown>;
      return {
        label: asString(m["label"]).trim(),
        quantity: asInt(m["quantity"], 1),
        unitPrice: asInt(m["unitPrice"], 0),
        lineTotal: asInt(m["lineTotal"], 0),
      };
    });

    const providerName =
      asString(job["providerName"] ?? job["selectedProviderName"] ?? job["serviceProviderName"]).trim() ||
      "Service Provider";

    // ---------------- APPLY DECISION ----------------
    if (decision === "declined") {
      // client declined → provider must confirm visitation fee payment
      await jobRef.set(
        {
          status: "quotation_declined_pending_visitation",
          quotationId: quotationDoc.id,
          quotationDecision: "declined",
          quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),
          visitationFee, // store for later analytics + payment creation
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // notify provider to confirm visitation payment
      await sendToUserTopic({
        userUid: selectedProviderUid,
        title: "Quotation Declined",
        body: "Client declined the quotation. Please confirm the visitation fee payment.",
        data: {
          route: "/provider/job_details",
          jobId,
          type: "visitation_fee_confirm_required",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });

      // notify contractor (optional but useful)
      if (contractorId) {
        await sendToUserTopic({
          userUid: contractorId,
          title: "Quotation Declined",
          body: "Client declined the quotation. Visitation fee confirmation is pending.",
          data: {
            route: "/dashboards/contractor/contractor_jobs_screen",
            jobId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
        });
      }

      return res.status(200).json({ ok: true });
    }

    // decision === "accepted"
    // client accepted → job task list & pricing updated for all parties
    await jobRef.set(
      {
        status: "quotation_accepted",
        quotationId: quotationDoc.id,
        quotationDecision: "accepted",
        quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),

        // overwrite tasks with quotation tasks
        tasks: mappedTasks,

        // store pricing summary on jobRequest for UI + analytics
        pricing: {
          visitationFee,
          platformFee,
          serviceTotal,
          totalAmount,
        },

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // notify contractor: button becomes Invoice on their UI (you’ll handle UI)
    if (contractorId) {
      await sendToUserTopic({
        userUid: contractorId,
        title: "Quotation Accepted",
        body: "Client accepted the quotation. You can now generate the invoice.",
        data: {
          route: "/dashboards/contractor/contractor_jobs_screen",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });
    }

    // notify provider: job details updated
    await sendToUserTopic({
      userUid: selectedProviderUid,
      title: "Quotation Accepted",
      body: "Client accepted the quotation. Job details have been updated.",
      data: {
        route: "/provider/job_details",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    // notify client: open updated job details
    await sendToUserTopic({
      userUid: clientId,
      title: "Quotation Accepted",
      body: `${providerName} will proceed with the updated job.`,
      data: {
        route: "/dashboards/client/client_jobs",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
