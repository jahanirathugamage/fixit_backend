// pages/api/cron/generate-recurring-jobs.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

type ApiResp =
  | {
      ok: true;
      generated: number;
      scanned: number;
      series: Array<{ seriesId: string; created: number }>;
    }
  | { ok: false; error: string; message?: string };

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

/**
 * Compute occurrence start Date objects
 * - index 0 is the "first job" (root) => we DO NOT generate a duplicate document for it.
 * - generated docs will be for indices 1..count-1
 */
function computeOccurrenceDates({
  startAt,
  preferredDay,
  frequency,
  count,
}: {
  startAt: admin.firestore.Timestamp;
  preferredDay: any;
  frequency: any;
  count: number;
}): Date[] {
  const baseDate = startAt.toDate();
  const preferred = weekdayIndexFromString(preferredDay);
  const freq = parseFrequency(frequency);

  let first = new Date(baseDate.getTime());

  // Align first to preferred weekday if provided
  if (preferred !== null) {
    while (first.getDay() !== preferred) {
      first = addDays(first, 1);
    }
  }

  const out: Date[] = [];
  let current = first;

  for (let i = 0; i < count; i++) {
    out.push(new Date(current.getTime()));

    if (freq.unit === "week") {
      current = addDays(current, freq.interval * 7);
    } else {
      const moved = addMonths(current, freq.interval);
      let aligned = new Date(moved.getTime());

      // If monthly + preferred day provided => pick first matching weekday of that month
      if (preferred !== null) {
        aligned = new Date(
          moved.getFullYear(),
          moved.getMonth(),
          1,
          moved.getHours(),
          moved.getMinutes(),
          0,
          0
        );
        while (aligned.getDay() !== preferred) aligned = addDays(aligned, 1);
      }

      // Keep time same as base startAt
      aligned.setHours(baseDate.getHours(), baseDate.getMinutes(), 0, 0);
      current = aligned;
    }
  }

  return out;
}

function asString(v: any): string {
  return String(v ?? "").trim();
}

/**
 * Generate future jobs only when root is accepted
 */
const GENERATE_WHEN_ROOT_STATUS_IN = new Set<string>(["accepted"]);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResp>
) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // ✅ Cron protection (supports BOTH header styles)
    // - vercel.json for generate uses NO headers currently -> so allow if no CRON_SECRET is set
    // - if CRON_SECRET is set -> accept either:
    //   1) x-cron-secret: <secret>
    //   2) Authorization: Bearer <secret>
    const cronKey = (process.env.CRON_SECRET ?? "").trim();
    if (cronKey) {
      const xCron = asString(req.headers["x-cron-secret"]);
      const auth = asString(req.headers.authorization);
      const match = auth.match(/^Bearer (.+)$/);

      const ok = xCron === cronKey || (match?.[1] ?? "") === cronKey;
      if (!ok) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
    }

    const db = admin.firestore();

    // ✅ Fetch ALL recurring jobs, then filter roots in code
    const recurringSnap = await db
      .collection("jobRequest")
      .where("isRecurring", "==", true)
      .get();

    let generated = 0;
    let scanned = 0;
    const seriesResults: Array<{ seriesId: string; created: number }> = [];

    for (const rootDoc of recurringSnap.docs) {
      const root = rootDoc.data() as any;
      const rootId = rootDoc.id;

      // ✅ Only process ROOTS (skip occurrences / child docs)
      const isOccurrence =
        Boolean(root.isRecurringOccurrence) ||
        asString(root.requestType).toLowerCase() === "recurring_occurrence" ||
        Number(root.recurrenceIndex ?? 0) > 0 ||
        asString(root.parentRecurringId).length > 0;

      if (isOccurrence) continue;

      scanned++;

      const status = asString(root.status).toLowerCase();
      if (!GENERATE_WHEN_ROOT_STATUS_IN.has(status)) {
        continue;
      }

      const recurrence = root.recurrence ?? {};
      const startAtTs =
        (recurrence.startAt as admin.firestore.Timestamp | undefined) ??
        (root.scheduledDate as admin.firestore.Timestamp | undefined);

      if (!startAtTs) continue;

      const preferredDay = recurrence.preferredDay ?? recurrence.day ?? null;
      const frequency =
        recurrence.frequency ?? recurrence.frequencyLabel ?? recurrence.interval ?? "1 week";

      const horizon = Number(recurrence.horizonCount ?? 6);
      const occCount = Number.isFinite(horizon)
        ? Math.min(Math.max(horizon, 2), 12)
        : 6;

      const dates = computeOccurrenceDates({
        startAt: startAtTs,
        preferredDay,
        frequency,
        count: occCount,
      });

      // ✅ Series id = existing or root id
      const seriesId = asString(root.recurrenceSeriesId ?? rootId) || rootId;

      // ✅ Existing occurrences in this series
      const existingSnap = await db
        .collection("jobRequest")
        .where("recurrenceSeriesId", "==", seriesId)
        .get();

      const existingIndices = new Set<number>();
      for (const d of existingSnap.docs) {
        const idx = Number((d.data() as any).recurrenceIndex ?? -1);
        if (Number.isFinite(idx) && idx >= 0) existingIndices.add(idx);
      }

      // ✅ Backfill root linkage if missing
      if (!root.recurrenceSeriesId || asString(root.recurrenceSeriesId) !== seriesId) {
        await rootDoc.ref.set(
          {
            recurrenceSeriesId: seriesId,
            recurrenceIndex: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else if (!Number.isFinite(Number(root.recurrenceIndex))) {
        await rootDoc.ref.set(
          {
            recurrenceIndex: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      let createdForSeries = 0;

      // Create docs for indices 1..occCount-1 if missing
      for (let idx = 1; idx < dates.length; idx++) {
        if (existingIndices.has(idx)) continue;

        const scheduledDate = admin.firestore.Timestamp.fromDate(dates[idx]);
        const newRef = db.collection("jobRequest").doc();

        const payload: Record<string, any> = {
          jobId: newRef.id,

          // Identity (same client)
          clientId: root.clientId ?? null,
          clientName: root.clientName ?? "Client",

          // Core details copied
          category: root.category ?? "",
          categoryNormalized:
            root.categoryNormalized ?? String(root.category ?? "").trim().toLowerCase(),

          locationText: root.locationText ?? "",
          location: root.location ?? null,

          isNow: false,
          scheduledDate,

          languagePrefs: Array.isArray(root.languagePrefs) ? root.languagePrefs : [],
          tasks: Array.isArray(root.tasks) ? root.tasks : [],

          pricing: root.pricing ?? {},

          // ✅ Assign same provider
          selectedProviderUid: root.selectedProviderUid ?? "",
          providerName: root.providerName ?? "",

          // ✅ Recurrence linkage
          isRecurring: true,
          isRecurringRequest: true,
          recurrenceSeriesId: seriesId,
          recurrenceIndex: idx,
          recurrence: recurrence,

          // ✅ Future jobs should show as scheduled
          status: "scheduled",

          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await newRef.set(payload);
        generated++;
        createdForSeries++;
      }

      if (createdForSeries > 0) {
        seriesResults.push({ seriesId, created: createdForSeries });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned,
      generated,
      series: seriesResults,
    });
  } catch (e: any) {
    console.error("generate-recurring-jobs error:", e);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate recurring jobs.",
      message: e?.message,
    });
  }
}
