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

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
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

    const body: Body = (req.body ?? {}) as Body;

    const jobId = asString(body.jobId).trim();
    const decision = asString(body.decision).trim().toLowerCase(); // accepted|declined

    if (!jobId) return res.status(400).json({ error: "jobId is required" });
    if (decision !== "accepted" && decision !== "declined") {
      return res.status(400).json({ error: "decision must be accepted|declined" });
    }

    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
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

    if (decision === "accepted") {
      await jobRef.set(
        {
          status: "quotation_accepted",
          quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({ ok: true });
    }

    // Declined → provider must confirm visitation fee
    await jobRef.set(
      {
        status: "awaiting_visitation_fee_confirmation",
        quotationDecisionAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Notify provider to confirm visitation fee
    await admin.messaging().send({
      topic: `user_${providerUid}`,
      notification: {
        title: "Visitation Fee",
        body: "Client declined the quotation. Please confirm visitation fee received.",
      },
      data: {
        type: "provider_confirm_visitation_fee",
        route: "/provider/confirm_visitation_fee",
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
