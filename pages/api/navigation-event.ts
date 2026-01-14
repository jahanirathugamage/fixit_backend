// pages/api/navigation-event.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

type NavEventType = "NAV_STARTED" | "NAV_UPDATE";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000; // meters
  const toRad = (x: number) => (x * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.sqrt(s));
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
    notification: {
      title: params.title,
      body: params.body,
    },
    data: params.data ?? {},
    android: {
      priority: "high",
    },
  });
}

/**
 * ✅ Atomic lock to prevent duplicate sends in race conditions.
 * - If the doc already exists => lock NOT acquired => do not send again
 * - If acquired but send fails => we delete the lock so it can retry later
 */
async function acquireNotifLock(lockId: string): Promise<boolean> {
  const ref = admin.firestore().collection("navNotificationLocks").doc(lockId);
  try {
    await ref.create({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch {
    // Firestore "already exists" or other create failure -> treat as not acquired
    return false;
  }
}

async function releaseNotifLock(lockId: string): Promise<void> {
  const ref = admin.firestore().collection("navNotificationLocks").doc(lockId);
  try {
    await ref.delete();
  } catch {
    // ignore
  }
}

type NavEventBody = {
  jobId?: unknown;
  type?: unknown;
  lat?: unknown;
  lng?: unknown;
  etaSeconds?: unknown;
};

type JobRequestDoc = {
  selectedProviderUid?: unknown;
  clientId?: unknown;
  providerName?: unknown;
  selectedProviderName?: unknown;
  serviceProviderName?: unknown;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  navigationNotifications?: {
    onTheWaySentAt?: unknown;
    tenMinSentAt?: unknown;
    arrivedSentAt?: unknown;
  };
};

type FirestoreUpdate = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function isNavEventType(v: unknown): v is NavEventType {
  return v === "NAV_STARTED" || v === "NAV_UPDATE";
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

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
    const body: NavEventBody = isRecord(req.body) ? (req.body as NavEventBody) : {};

    const jobId = body.jobId;
    const type = body.type;
    const lat = body.lat;
    const lng = body.lng;
    const etaSeconds = body.etaSeconds;

    if (typeof jobId !== "string" || !jobId.trim()) {
      return res.status(400).json({ error: "jobId is required" });
    }

    if (!isNavEventType(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    // ---- LOAD JOB (jobRequest) ----
    const jobRef = admin.firestore().collection("jobRequest").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return res.status(404).json({ error: "Job not found" });

    const rawJob = (jobSnap.data() ?? {}) as JobRequestDoc;

    const selectedProviderUid = asString(rawJob.selectedProviderUid).trim();
    const clientId = asString(rawJob.clientId).trim();

    if (!selectedProviderUid || !clientId) {
      return res.status(400).json({ error: "Job missing selectedProviderUid/clientId" });
    }

    // Provider must be the assigned provider
    if (selectedProviderUid !== callerUid) {
      return res.status(403).json({ error: "Not allowed (not selected provider)" });
    }

    const providerName =
      asString(
        rawJob.providerName ??
          rawJob.selectedProviderName ??
          rawJob.serviceProviderName ??
          "Your service provider"
      ).trim() || "Your service provider";

    const notif =
      (rawJob.navigationNotifications ?? {}) as NonNullable<JobRequestDoc["navigationNotifications"]>;

    const updates: FirestoreUpdate = {
      "navigation.lastEventAt": admin.firestore.FieldValue.serverTimestamp(),
      "navigation.lastEventType": type,
      "navigation.lastProviderUid": callerUid,
      "navigation.lastProviderName": providerName,
    };

    // Store last provider position if provided
    if (isFiniteNumber(lat) && isFiniteNumber(lng)) {
      updates["navigation.lastProviderLat"] = lat;
      updates["navigation.lastProviderLng"] = lng;
      updates["navigation.lastLocationAt"] = admin.firestore.FieldValue.serverTimestamp();
    }

    // ---- NAV_STARTED => send "On the way" once ----
    if (type === "NAV_STARTED") {
      if (!notif.onTheWaySentAt) {
        await sendToUserTopic({
          userUid: clientId,
          title: "On the way",
          body: `${providerName} is on the way to your job.`,
          data: { jobId, type: "on_the_way" },
        });

        updates["navigationNotifications.onTheWaySentAt"] =
          admin.firestore.FieldValue.serverTimestamp();
      }
    }

    // ---- NAV_UPDATE => check ETA(<=10min) and Arrived (distance) ----
    if (type === "NAV_UPDATE") {
      // ✅ 10-min notification ONCE (race-safe)
      if (isFiniteNumber(etaSeconds) && etaSeconds <= 600 && !notif.tenMinSentAt) {
        const lockId = `${jobId}_ten_min`;

        const locked = await acquireNotifLock(lockId);
        if (locked) {
          try {
            await sendToUserTopic({
              userUid: clientId,
              title: "Almost there",
              body: `${providerName} is about 10 minutes away.`,
              data: { jobId, type: "ten_min" },
            });

            updates["navigationNotifications.tenMinSentAt"] =
              admin.firestore.FieldValue.serverTimestamp();
          } catch (err: unknown) {
            await releaseNotifLock(lockId);
            throw err;
          }
        }
      }

      // ✅ Arrived notification ONCE (race-safe)
      const jobLoc = rawJob.location;
      const jobLat = jobLoc && isRecord(jobLoc) ? jobLoc.latitude : undefined;
      const jobLng = jobLoc && isRecord(jobLoc) ? jobLoc.longitude : undefined;

      if (
        isFiniteNumber(lat) &&
        isFiniteNumber(lng) &&
        isFiniteNumber(jobLat) &&
        isFiniteNumber(jobLng) &&
        !notif.arrivedSentAt
      ) {
        const dist = haversineMeters({ lat, lng }, { lat: jobLat, lng: jobLng });

        const ARRIVE_THRESHOLD_METERS = 120;

        if (dist <= ARRIVE_THRESHOLD_METERS) {
          const lockId = `${jobId}_arrived`;

          const locked = await acquireNotifLock(lockId);
          if (locked) {
            try {
              await sendToUserTopic({
                userUid: clientId,
                title: "Arrived",
                body: `${providerName} has arrived.`,
                data: { jobId, type: "arrived" },
              });

              updates["navigationNotifications.arrivedSentAt"] =
                admin.firestore.FieldValue.serverTimestamp();
            } catch (err: unknown) {
              await releaseNotifLock(lockId);
              throw err;
            }
          }
        }
      }
    }

    await jobRef.set(updates, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ error: getErrorMessage(e) });
  }
}
