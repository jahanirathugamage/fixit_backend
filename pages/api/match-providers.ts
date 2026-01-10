// pages/api/match-providers.ts

/* eslint-disable @typescript-eslint/no-explicit-any */


import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type ApiError = { error: string; code?: string; message?: string };

type ServiceTaskDuration = {
  taskName: string;
  durationHours: number;
  durationMinutes: number;
};

function normalizeCategory(input: any): string {
  return String(input ?? "").trim().toLowerCase();
}

function isNonEmptyString(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function addMinutes(ts: admin.firestore.Timestamp, mins: number) {
  const ms = ts.toMillis() + mins * 60_000;
  return admin.firestore.Timestamp.fromMillis(ms);
}

async function getCallerRole(uid: string): Promise<string | null> {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return snap.exists ? (snap.data()?.role as string) : null;
}

/**
 * Looks up serviceTasks duration by taskName (jobRequest.tasks[].label).
 * Simple implementation: 1 query per unique label.
 */
async function fetchDurationsByLabels(
  labels: string[],
): Promise<Map<string, ServiceTaskDuration>> {
  const db = admin.firestore();
  const result = new Map<string, ServiceTaskDuration>();

  const unique = Array.from(
    new Set(labels.map((l) => String(l).trim()).filter((l) => l.length > 0)),
  );

  for (const label of unique) {
    const qs = await db
      .collection("serviceTasks")
      .where("taskName", "==", label)
      .limit(1)
      .get();

    if (!qs.empty) {
      const d = qs.docs[0].data() as any;
      result.set(label, {
        taskName: String(d.taskName ?? label),
        durationHours: Number(d.durationHours ?? 0),
        durationMinutes: Number(d.durationMinutes ?? 0),
      });
    }
  }

  return result;
}

function computeTotalDurationMinutes(
  tasks: any[],
  durationsByLabel: Map<string, ServiceTaskDuration>,
): number {
  let total = 0;

  for (const t of tasks) {
    const label = String(t?.label ?? "").trim();
    const qtyRaw = t?.quantity;
    const quantity = Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : 1;

    if (!label) continue;

    const dur = durationsByLabel.get(label);
    if (!dur) continue;

    const minsPerUnit = dur.durationHours * 60 + dur.durationMinutes;
    total += minsPerUnit * Math.max(1, quantity);
  }

  return total;
}

/**
 * Availability check:
 * Query blocks where blockStartAt < requestedBlockEnd,
 * then filter in-memory for overlap: blockEndAt > requestedBlockStart.
 * Ignore expired holds.
 */
async function providerHasOverlap(
  providerUid: string,
  requestedBlockStart: admin.firestore.Timestamp,
  requestedBlockEnd: admin.firestore.Timestamp,
): Promise<boolean> {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  // ✅ Only ONE inequality in Firestore query (no composite index needed)
  const blocksSnap = await db
    .collection("serviceProviders")
    .doc(providerUid)
    .collection("timeBlocks")
    .where("blockStartAt", "<", requestedBlockEnd)
    .get();

  for (const doc of blocksSnap.docs) {
    const b = doc.data() as any;

    const status = String(b.status ?? "");
    if (status !== "held" && status !== "booked") continue;

    const blockStartAt = b.blockStartAt as admin.firestore.Timestamp | undefined;
    const blockEndAt = b.blockEndAt as admin.firestore.Timestamp | undefined;
    if (!blockStartAt || !blockEndAt) continue;

    // Ignore expired holds
    if (status === "held") {
      const holdExpiresAt = b.holdExpiresAt as admin.firestore.Timestamp | undefined;
      if (holdExpiresAt && holdExpiresAt.toMillis() < now.toMillis()) {
        continue;
      }
    }

    // ✅ Do the second overlap check in code
    const overlaps =
      blockStartAt.toMillis() < requestedBlockEnd.toMillis() &&
      blockEndAt.toMillis() > requestedBlockStart.toMillis();

    if (overlaps) return true;
  }

  return false;
}


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiError | any>,
) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Verify client identity
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const role = await getCallerRole(callerUid);
    if (role !== "client") {
      return res.status(403).json({ error: "Only clients can match providers." });
    }

    // 2) Body
    const { jobId = "" } = req.body || {};
    const jobRequestId = String(jobId).trim();
    if (!jobRequestId) return res.status(400).json({ error: "Missing jobId." });

    const db = admin.firestore();

    // 3) Load jobRequest
    const jobRef = db.collection("jobRequest").doc(jobRequestId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job request not found." });

    const job = jobSnap.data() as any;

    const isNow = Boolean(job.isNow);
    const scheduledDate = job.scheduledDate as admin.firestore.Timestamp | undefined;

    // Prefer categoryNormalized if you have it, else fallback to category
    const category = normalizeCategory(job.categoryNormalized ?? job.category);
    if (!category) return res.status(400).json({ error: "Job request missing category/categoryNormalized." });

    const jobLocation = job.location as admin.firestore.GeoPoint | undefined;
    if (!jobLocation) return res.status(400).json({ error: "Job request missing location GeoPoint." });

    const tasks = Array.isArray(job.tasks) ? job.tasks : [];

    // 4) Compute window (startAt + duration + buffers)
    const startAt: admin.firestore.Timestamp = isNow
      ? admin.firestore.Timestamp.now()
      : scheduledDate ?? admin.firestore.Timestamp.now();

    const labels = tasks
      .map((t: any) => String(t?.label ?? "").trim())
      .filter(isNonEmptyString);

    const durationsByLabel = await fetchDurationsByLabels(labels);
    const totalDurationMins = computeTotalDurationMinutes(tasks, durationsByLabel);

    const bufferBeforeMins = 60;
    const bufferAfterMins = 60;

    const endAt = addMinutes(startAt, totalDurationMins);
    const blockStartAt = addMinutes(startAt, -bufferBeforeMins);
    const blockEndAt = addMinutes(endAt, bufferAfterMins);

    // 5) Query providers by category
    const providerSnap = await db
      .collection("serviceProviders")
      .where("categoriesNormalized", "array-contains", category)
      .get();

    // 6) Filter by availability
    const availableProviders: any[] = [];

    for (const doc of providerSnap.docs) {
      const p = doc.data() as any;
      const providerUid = String(p.providerUid ?? doc.id);

      const hasOverlap = await providerHasOverlap(providerUid, blockStartAt, blockEndAt);
      if (hasOverlap) continue;

      const gp = p.location as admin.firestore.GeoPoint | undefined;

      availableProviders.push({
        providerUid,
        firstName: p.firstName ?? null,
        lastName: p.lastName ?? null,
        languages: Array.isArray(p.languages) ? p.languages : [],
        // ✅ JSON-friendly location
        location: gp ? { lat: gp.latitude, lng: gp.longitude } : null,
      });
    }

    const jobLocationJson = {
    lat: jobLocation.latitude,
    lng: jobLocation.longitude,
  };

    return res.status(200).json({
    ok: true,
    jobId: jobRequestId,

    jobLocation: jobLocationJson,

    startAt: startAt.toDate().toISOString(),
    endAt: endAt.toDate().toISOString(),
    blockStartAt: blockStartAt.toDate().toISOString(),
    blockEndAt: blockEndAt.toDate().toISOString(),

    totalDurationMins,
    bufferBeforeMins,
    bufferAfterMins,

    providers: availableProviders,
    });
  } catch (err: any) {
    console.error("match-providers error:", err);
    return res.status(500).json({
      error: "Failed to match providers.",
      code: err?.code,
      message: err?.message,
    });
  }
}
