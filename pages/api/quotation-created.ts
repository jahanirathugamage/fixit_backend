// pages/api/quotation-created.ts
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
    const callerUid = decoded.uid; // contractor

    // ---- INPUT ----
    const body: Body = isRecord(req.body) ? (req.body as Body) : {};
    const jobId = asString(body.jobId).trim();
    if (!jobId) return res.status(400).json({ error: "jobId is required" });

    // ---- LOAD JOB ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job not found" });

    const job = jobSnap.data() ?? {};
    const clientId = asString(job["clientId"]).trim();
    const selectedProviderUid = asString(job["selectedProviderUid"]).trim();

    if (!clientId || !selectedProviderUid) {
      return res.status(400).json({ error: "Job missing clientId/selectedProviderUid" });
    }

    // ---- AUTHORIZE CONTRACTOR (owns selected provider via serviceProviders.managedBy) ----
    const provSnap = await admin.firestore().collection("serviceProviders").doc(selectedProviderUid).get();
    if (!provSnap.exists) return res.status(400).json({ error: "Selected provider not found" });

    const prov = provSnap.data() ?? {};
    const managedBy = prov["managedBy"];
    const expected = admin.firestore().doc(`contractors/${callerUid}`).path;

    const managedByPath =
      typeof managedBy?.path === "string"
        ? managedBy.path
        : (typeof managedBy === "string" ? managedBy : "");

    if (!managedByPath || managedByPath !== expected) {
      return res.status(403).json({ error: "Not allowed (contractor does not manage provider)" });
    }

    // ---- NOTIFY CLIENT ----
    await sendToUserTopic({
      userUid: clientId,
      title: "Quotation Ready",
      body: "A quotation has been created. Please review it.",
      data: {
        type: "client_quotation_created",
        jobId,
        route: "/client/quotation_review",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    });

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
