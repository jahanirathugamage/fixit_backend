import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isTimestamp(v: unknown): v is admin.firestore.Timestamp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof v === "object" && v !== null && typeof (v as any).toDate === "function";
}

function sameInstant(a?: admin.firestore.Timestamp, b?: admin.firestore.Timestamp): boolean {
  if (!a || !b) return false;
  return a.toMillis() === b.toMillis();
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

/**
 * Recurring Reminder Rules:
 * 1) Do NOT send reminder for FIRST job in recurrence.
 * 2) For NEXT jobs, send reminder 48 hours before scheduledDate.
 * 3) Notify both client + provider; tap goes to that scheduled job's job details.
 *
 * Vercel Hobby constraint:
 * - Cron can only run ONCE per day, and timing is not exact.
 * - Therefore we widen the "48h" matching window to ensure reminders still send.
 *
 * Daily scan window:
 * - scheduledDate in [48h, 72h] from now (plus drift buffer)
 * - Prevent duplicates using reminder48hSent.
 */

// Daily cron window: 48h to 72h ahead
const WINDOW_START_HOURS = 48;
const WINDOW_END_HOURS = 72;

// Buffer to tolerate cron drift
const DRIFT_BUFFER_MINUTES = 90;

function requireCronAuth(req: NextApiRequest): string | null {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return null;

  const auth = asString(req.headers.authorization).trim();
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return "Missing Bearer token";
  if (match[1] !== secret) return "Invalid token";
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authErr = requireCronAuth(req);
  if (authErr) return res.status(401).json({ error: authErr });

  try {
    const db = admin.firestore();
    const now = new Date();

    const windowStart = new Date(
      now.getTime() +
        WINDOW_START_HOURS * 60 * 60 * 1000 -
        DRIFT_BUFFER_MINUTES * 60 * 1000
    );
    const windowEnd = new Date(
      now.getTime() +
        WINDOW_END_HOURS * 60 * 60 * 1000 +
        DRIFT_BUFFER_MINUTES * 60 * 1000
    );

    const startTs = admin.firestore.Timestamp.fromDate(windowStart);
    const endTs = admin.firestore.Timestamp.fromDate(windowEnd);

    const snap = await db
      .collection("jobRequest")
      .where("scheduledDate", ">=", startTs)
      .where("scheduledDate", "<", endTs)
      .get();

    let considered = 0;
    let sent = 0;
    let skippedFirst = 0;
    let skippedNotRecurring = 0;
    let skippedAlreadySent = 0;
    let skippedMissingUsers = 0;
    let skippedCancelled = 0;
    let skippedMissingSchedule = 0;

    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      considered++;

      const jobId = doc.id;

      const scheduledDateRaw = data["scheduledDate"];
      const schedTs = isTimestamp(scheduledDateRaw) ? scheduledDateRaw : undefined;
      if (!schedTs) {
        skippedMissingSchedule++;
        continue;
      }

      const isRecurring =
        Boolean(data["isRecurringRequest"]) ||
        Boolean(data["isRecurring"]) ||
        asString(data["requestType"]).trim().toLowerCase() === "recurring";

      if (!isRecurring) {
        skippedNotRecurring++;
        continue;
      }

      const alreadySent = Boolean(data["reminder48hSent"]);
      if (alreadySent) {
        skippedAlreadySent++;
        continue;
      }

      const status = asString(data["status"]).trim().toLowerCase();
      if (
        status.includes("cancel") ||
        status.includes("terminated") ||
        status.includes("stopped")
      ) {
        skippedCancelled++;
        continue;
      }

      const recurrence =
        data["recurrence"] && typeof data["recurrence"] === "object"
          ? (data["recurrence"] as Record<string, unknown>)
          : {};

      const startAtRaw = recurrence["startAt"];
      const startAt = isTimestamp(startAtRaw) ? startAtRaw : undefined;

      if (startAt && sameInstant(schedTs, startAt)) {
        skippedFirst++;
        await doc.ref.set(
          {
            reminder48hSent: true,
            reminder48hSentAt: admin.firestore.FieldValue.serverTimestamp(),
            reminder48hSkipReason: "first_job_of_recurrence",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      const clientId = asString(data["clientId"]).trim();
      const providerUid = asString(data["selectedProviderUid"]).trim();

      if (!clientId || !providerUid) {
        skippedMissingUsers++;
        continue;
      }

      const providerName =
        asString(
          data["providerName"] ??
            data["selectedProviderName"] ??
            data["serviceProviderName"]
        ).trim() || "Service Provider";

      const title = "Upcoming Scheduled Service";
      const bodyClient = "Reminder: Your scheduled service is in 2 days. Tap to view details.";
      const bodyProvider = "Reminder: You have a scheduled job in 2 days. Tap to view details.";

      await sendToUserTopic({
        userUid: clientId,
        title,
        body: bodyClient,
        data: {
          type: "recurring_job_reminder_48h",
          route: "/dashboards/client/job_details",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });

      await sendToUserTopic({
        userUid: providerUid,
        title,
        body: bodyProvider,
        data: {
          type: "recurring_job_reminder_48h",
          route: "/provider/job_details",
          jobId,
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      });

      await doc.ref.set(
        {
          reminder48hSent: true,
          reminder48hSentAt: admin.firestore.FieldValue.serverTimestamp(),
          reminder48hMeta: {
            providerName,
            window: {
              start: windowStart.toISOString(),
              end: windowEnd.toISOString(),
              driftBufferMinutes: DRIFT_BUFFER_MINUTES,
            },
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      sent++;
    }

    return res.status(200).json({
      ok: true,
      cronMode: "daily_hobby",
      window: {
        startHours: WINDOW_START_HOURS,
        endHours: WINDOW_END_HOURS,
        driftBufferMinutes: DRIFT_BUFFER_MINUTES,
      },
      matchedInWindow: snap.size,
      considered,
      sent,
      skipped: {
        notRecurring: skippedNotRecurring,
        firstJob: skippedFirst,
        alreadySent: skippedAlreadySent,
        missingUsers: skippedMissingUsers,
        cancelled: skippedCancelled,
        missingSchedule: skippedMissingSchedule,
      },
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      now: now.toISOString(),
    });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
