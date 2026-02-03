// pages/api/hold-provider.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type ApiError = { error: string; code?: string; message?: string };

function addMinutes(ts: admin.firestore.Timestamp, mins: number) {
  const ms = ts.toMillis() + mins * 60_000;
  return admin.firestore.Timestamp.fromMillis(ms);
}

function addDays(date: Date, days: number) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

async function getCallerRole(uid: string): Promise<string | null> {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  return snap.exists ? (snap.data()?.role as string) : null;
}

function normalizeCategory(input: any): string {
  return String(input ?? "").trim().toLowerCase();
}

function isNonEmptyString(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

type ServiceTaskDuration = {
  taskName: string;
  durationHours: number;
  durationMinutes: number;
};

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

async function providerHasOverlap(
  providerUid: string,
  requestedBlockStart: admin.firestore.Timestamp,
  requestedBlockEnd: admin.firestore.Timestamp,
): Promise<boolean> {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

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

    if (status === "held") {
      const holdExpiresAt = b.holdExpiresAt as admin.firestore.Timestamp | undefined;
      if (holdExpiresAt && holdExpiresAt.toMillis() < now.toMillis()) continue;
    }

    const overlaps =
      blockStartAt.toMillis() < requestedBlockEnd.toMillis() &&
      blockEndAt.toMillis() > requestedBlockStart.toMillis();

    if (overlaps) return true;
  }

  return false;
}

function weekdayIndexFromString(v: any): number | null {
  const s = String(v ?? "").trim().toLowerCase();
  const map: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };
  return map[s] ?? null;
}

function parseFrequency(raw: any): { unit: "week" | "month"; interval: number } {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/(\d+)\s*(week|weeks|month|months)/i);
  if (!m) return { unit: "week", interval: 1 };
  const interval = Math.max(1, Number(m[1] ?? 1));
  const unitRaw = (m[2] ?? "week").toLowerCase();
  if (unitRaw.startsWith("month")) return { unit: "month", interval };
  return { unit: "week", interval };
}

function computeOccurrences({
  startAt,
  preferredDay,
  frequency,
  count,
}: {
  startAt: admin.firestore.Timestamp;
  preferredDay: any;
  frequency: any;
  count: number;
}): admin.firestore.Timestamp[] {
  const baseDate = startAt.toDate();
  const preferred = weekdayIndexFromString(preferredDay);
  const freq = parseFrequency(frequency);

  let first = new Date(baseDate.getTime());
  if (preferred !== null) {
    while (first.getDay() !== preferred) {
      first = addDays(first, 1);
    }
  }

  const out: admin.firestore.Timestamp[] = [];
  let current = first;

  for (let i = 0; i < count; i++) {
    out.push(admin.firestore.Timestamp.fromDate(new Date(current.getTime())));

    if (freq.unit === "week") {
      current = addDays(current, freq.interval * 7);
    } else {
      const moved = addMonths(current, freq.interval);
      let aligned = new Date(moved.getTime());

      if (preferred !== null) {
        aligned = new Date(moved.getFullYear(), moved.getMonth(), 1, moved.getHours(), moved.getMinutes(), 0, 0);
        while (aligned.getDay() !== preferred) aligned = addDays(aligned, 1);
      }

      aligned.setHours(baseDate.getHours(), baseDate.getMinutes(), 0, 0);
      current = aligned;
    }
  }

  return out;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiError | any>,
) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const role = await getCallerRole(callerUid);
    if (role !== "client") {
      return res.status(403).json({ error: "Only clients can hold providers." });
    }

    const { jobId = "", providerUid = "" } = req.body || {};
    const jobRequestId = String(jobId).trim();
    const pUid = String(providerUid).trim();

    if (!jobRequestId) return res.status(400).json({ error: "Missing jobId." });
    if (!pUid) return res.status(400).json({ error: "Missing providerUid." });

    const db = admin.firestore();

    const jobRef = db.collection("jobRequest").doc(jobRequestId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job request not found." });

    const job = jobSnap.data() as any;

    const category = normalizeCategory(job.categoryNormalized ?? job.category);
    if (!category) {
      return res.status(400).json({ error: "Job request missing category/categoryNormalized." });
    }

    const jobLocation = job.location as admin.firestore.GeoPoint | undefined;
    if (!jobLocation) {
      return res.status(400).json({ error: "Job request missing location GeoPoint." });
    }

    const tasks = Array.isArray(job.tasks) ? job.tasks : [];

    const startAtBase: admin.firestore.Timestamp =
      (job.scheduledDate as admin.firestore.Timestamp | undefined) ?? admin.firestore.Timestamp.now();

    const labels = tasks
      .map((t: any) => String(t?.label ?? "").trim())
      .filter(isNonEmptyString);

    const durationsByLabel = await fetchDurationsByLabels(labels);
    const totalDurationMins = computeTotalDurationMinutes(tasks, durationsByLabel);

    const bufferBeforeMins = 60;
    const bufferAfterMins = 60;

    const isRecurring = Boolean(job.isRecurring);
    const recurrence = job.recurrence ?? {};
    const preferredDay = recurrence.preferredDay ?? recurrence.day ?? null;
    const frequency = recurrence.frequency ?? recurrence.interval ?? "1 week";
    const horizon = Number(recurrence.horizonCount ?? 6);
    const occCount = Number.isFinite(horizon) ? Math.min(Math.max(horizon, 2), 12) : 6;

    const occurrenceStarts = isRecurring
      ? computeOccurrences({
          startAt: startAtBase,
          preferredDay,
          frequency,
          count: occCount,
        })
      : [startAtBase];

    const requestedWindows = occurrenceStarts.map((occStart) => {
      const endAt = addMinutes(occStart, totalDurationMins);
      const blockStartAt = addMinutes(occStart, -bufferBeforeMins);
      const blockEndAt = addMinutes(endAt, bufferAfterMins);
      return { occStart, endAt, blockStartAt, blockEndAt };
    });

    // Ensure provider is still available for ALL occurrences
    for (const w of requestedWindows) {
      const hasOverlap = await providerHasOverlap(pUid, w.blockStartAt, w.blockEndAt);
      if (hasOverlap) {
        return res.status(409).json({
          error: "Provider unavailable",
          message:
            "This provider has an overlapping booking/hold. Please select another provider.",
        });
      }
    }

    // Create holds
    const holdMinutes = 10;
    const now = admin.firestore.Timestamp.now();
    const holdExpiresAt = addMinutes(now, holdMinutes);

    const holds: { holdId: string; startAt: string }[] = [];

    for (let i = 0; i < requestedWindows.length; i++) {
      const w = requestedWindows[i];

      const holdRef = db
        .collection("serviceProviders")
        .doc(pUid)
        .collection("timeBlocks")
        .doc();

      await holdRef.set({
        status: "held",
        jobId: jobRequestId,
        clientId: callerUid,

        // actual service window for this occurrence
        startAt: w.occStart,
        endAt: w.endAt,

        // padded block for availability
        blockStartAt: w.blockStartAt,
        blockEndAt: w.blockEndAt,

        // recurring linkage
        isRecurring: isRecurring,
        occurrenceIndex: i,
        recurrenceJobId: isRecurring ? jobRequestId : null,

        holdExpiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      holds.push({ holdId: holdRef.id, startAt: w.occStart.toDate().toISOString() });
    }

    // Save selection onto jobRequest for provider to see
    await jobRef.set(
      {
        selectedProviderUid: pUid,
        holdId: holds[0]?.holdId ?? null,
        holdExpiresAt,
        status: "requested",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.status(200).json({
      ok: true,
      jobId: jobRequestId,
      providerUid: pUid,
      holds,
      holdExpiresAt: holdExpiresAt.toDate().toISOString(),
      holdMinutes,
      status: "requested",
      isRecurring,
    });
  } catch (err: any) {
    console.error("hold-provider error:", err);
    return res.status(500).json({
      error: "Failed to hold provider.",
      code: err?.code,
      message: err?.message,
    });
  }
}
