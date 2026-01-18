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
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const callerUid = decoded.uid;

    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    const decision = asString(body.decision).trim().toLowerCase();

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (decision !== "accepted" && decision !== "declined") {
      return res.status(400).json({ error: "decision must be accepted|declined" });
    }

    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job not found" });

    const job = jobSnap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !selectedProviderUid) {
      return res.status(400).json({ error: "Job missing clientId/selectedProviderUid" });
    }

    if (clientId !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not client owner)" });
    }

    // Load quotation (NO orderBy, no composite index)
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

    const providerName =
      asString(job["providerName"] ?? job["selectedProviderName"] ?? job["serviceProviderName"]).trim() ||
      "Service Provider";

    if (decision === "declined") {
      await jobRef.set(
        {
          status: "quotation_declined_pending_visitation",
          quotationId: quotationDoc.id,
          contractorId: contractorId || admin.firestore.FieldValue.delete(),
          quotationDecision: "declined",
          quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

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

    // ✅ ACCEPTED: DO NOT overwrite jobRequest.tasks/pricing.
    // Keep original job request details intact.
    await jobRef.set(
      {
        status: "quotation_accepted",
        quotationId: quotationDoc.id,
        contractorId: contractorId || admin.firestore.FieldValue.delete(),
        quotationDecision: "accepted",
        quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

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

    await sendToUserTopic({
      userUid: selectedProviderUid,
      title: "Quotation Accepted",
      body: "Client accepted the quotation. Updated job details are available.",
      data: {
        route: "/provider/job_details",
        jobId,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

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
