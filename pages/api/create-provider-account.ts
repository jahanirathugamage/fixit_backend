// pages/api/create-provider-account.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

const MIRROR_VERSION = "vercel-create-provider-v2-mirror-skills-proof";

function normalizeAddress(input: string): string {
  const raw = String(input || "").trim();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const deduped: string[] = [];
  for (const p of parts) {
    if (
      deduped.length === 0 ||
      deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()
    ) {
      deduped.push(p);
    }
  }
  return deduped.join(", ");
}

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type Geo = { lat: number; lng: number };

type GeocodeMeta = {
  source: "nominatim" | "pin";
  query: string;
  displayName?: string | null;
  status: "ok" | "no_results" | "pin";
  updatedAt: admin.firestore.FieldValue;
};

function sanitizeStringArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length > 0);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const v of cleaned) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }
  return deduped;
}

function parsePinnedLocation(raw: any): Geo | null {
  if (!raw || typeof raw !== "object") return null;

  const lat = Number((raw as any).lat);
  const lng = Number((raw as any).lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;

  return { lat, lng };
}

/**
 * Keep skills structure EXACTLY (Flutter expects skills[0].education/certifications/jobExperience).
 * We only ensure it’s an array of objects.
 */
function sanitizeSkills(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === "object").map((x) => x);
}

async function geocodeAddress(
  address: string,
): Promise<{ geo: Geo; meta: { query: string; displayName?: string | null } } | null> {
  const query = String(address || "").trim();
  if (query.length < 6) return null;

  async function callNominatim(q: string) {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?q=${encodeURIComponent(q)}` +
      "&format=json&limit=3&addressdetails=1" +
      "&countrycodes=lk";

    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "FixIt-Academic-Project/1.0 (geocoding; contact: your-email@example.com)",
        Accept: "application/json",
        "Accept-Language": "en",
      },
    });

    if (!resp.ok) return [] as Array<{ lat: string; lon: string; display_name?: string }>;

    const data = (await resp.json()) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
    }>;

    return Array.isArray(data) ? data : [];
  }

  try {
    let data = await callNominatim(query);

    if (!data.length) {
      const fallback = query
        .replace(/^\s*(no\.?\s*)?\d+[a-zA-Z0-9\/-]*\s*,\s*/i, "")
        .trim();

      if (fallback && fallback !== query) {
        data = await callNominatim(fallback);
      }
    }

    if (!data.length) return null;

    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      geo: { lat, lng },
      meta: {
        query,
        displayName: data[0].display_name ?? null,
      },
    };
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const FieldValue = admin.firestore.FieldValue;

  try {
    // 1) Verify contractor identity
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const userSnap = await admin.firestore().collection("users").doc(callerUid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;

    if (role !== "contractor") {
      return res.status(403).json({ error: "Only contractors can create provider accounts." });
    }

    // 2) Read request body
    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
      address = "",
      languages = [],
      skills = [],
      categories = [],
      categoriesNormalized = [],
      location = null,
    } = req.body || {};

    const mail = String(email).trim().toLowerCase();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim();
    const fullAddress = normalizeAddress(address).trim();

    const langs = Array.isArray(languages) ? languages : [];
    const reqSkills = sanitizeSkills(skills);

    if (!mail || !mail.includes("@")) return res.status(400).json({ error: "Invalid email." });
    if (!pw || pw.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (!providerId) return res.status(400).json({ error: "Missing providerDocId." });

    // 3) Read contractor provider subdoc (SOURCE OF TRUTH)
    const contractorProviderRef = admin
      .firestore()
      .collection("contractors")
      .doc(callerUid)
      .collection("providers")
      .doc(providerId);

    const contractorProviderSnap = await contractorProviderRef.get();
    const contractorProviderData = contractorProviderSnap.exists
      ? (contractorProviderSnap.data() as Record<string, any>)
      : {};

    const finalCategories =
      sanitizeStringArray(contractorProviderData?.categories).length > 0
        ? sanitizeStringArray(contractorProviderData?.categories)
        : sanitizeStringArray(categories);

    const finalCategoriesNormalized =
      sanitizeStringArray(contractorProviderData?.categoriesNormalized).length > 0
        ? sanitizeStringArray(contractorProviderData?.categoriesNormalized)
        : sanitizeStringArray(categoriesNormalized);

    // ✅ skills from contractor doc if present
    const finalSkills =
      Array.isArray(contractorProviderData?.skills) && contractorProviderData.skills.length > 0
        ? sanitizeSkills(contractorProviderData.skills)
        : reqSkills;

    const skillsCount = Array.isArray(finalSkills) ? finalSkills.length : 0;

    // 4) Create Auth user
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    const providerUid = userRecord.uid;
    const contractorRef = admin.firestore().doc(`contractors/${callerUid}`);

    // 5) Create/merge users/{providerUid}
    await admin.firestore().collection("users").doc(providerUid).set(
      {
        role: "provider",
        firstName: fName,
        lastName: lName,
        email: mail,
        contractorId: callerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 6) Geo (pin > nominatim)
    const pinned = parsePinnedLocation(location);

    let geo: Geo | null = null;
    const geoFields: Record<string, any> = {};

    if (pinned) {
      geo = pinned;
      geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
      geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
      geoFields.geocode = {
        source: "pin",
        query: fullAddress || "",
        displayName: null,
        status: "pin",
        updatedAt: FieldValue.serverTimestamp(),
      } satisfies GeocodeMeta;
    } else {
      geoFields.geocode = {
        source: "nominatim",
        query: fullAddress || "",
        displayName: null,
        status: "no_results",
        updatedAt: FieldValue.serverTimestamp(),
      } satisfies GeocodeMeta;

      const geocoded = await geocodeAddress(fullAddress);
      if (geocoded) {
        geo = geocoded.geo;
        geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
        geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
        geoFields.geocode = {
          source: "nominatim",
          query: geocoded.meta.query,
          displayName: geocoded.meta.displayName ?? null,
          status: "ok",
          updatedAt: FieldValue.serverTimestamp(),
        } satisfies GeocodeMeta;
      }
    }

    // 7) Update contractor subdoc
    await contractorProviderRef.set(
      {
        providerUid,
        email: mail,
        firstName: fName,
        lastName: lName,
        address: fullAddress || "",
        languages: langs,
        skills: finalSkills,
        managedBy: contractorRef,
        contractorId: callerUid,
        updatedAt: FieldValue.serverTimestamp(),
        categories: finalCategories,
        categoriesNormalized: finalCategoriesNormalized,
        ...geoFields,
      },
      { merge: true },
    );

    // 8) ✅ Mirror into serviceProviders/{providerUid}
    await admin.firestore().collection("serviceProviders").doc(providerUid).set(
      {
        providerUid,
        providerEmail: mail,
        managedBy: contractorRef,
        contractorId: callerUid,

        address: { fullAddress: fullAddress || "" },

        firstName: fName,
        lastName: lName,
        languages: langs,

        categories: finalCategories,
        categoriesNormalized: finalCategoriesNormalized,

        // ✅ THE IMPORTANT FIELD
        skills: finalSkills,

        // ✅ PROOF FIELDS (verify deployed version)
        mirrorVersion: MIRROR_VERSION,
        skillsCount,
        mirroredAt: FieldValue.serverTimestamp(),
        mirroredFromProviderDocId: providerId,

        ...geoFields,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 9) Email
    const subject = "Your FixIt provider account";
    const text =
      `Hi ${fName || ""},\n\n` +
      "A FixIt contractor has registered you as a service provider.\n\n" +
      "You can now log in with:\n\n" +
      `Email: ${mail}\n` +
      `Password: ${pw}\n\n` +
      "For security, please log in and change your password after first sign in.\n\n" +
      "– FixIt Team";

    await sendEmail(mail, subject, text);

    return res.status(200).json({
      ok: true,
      providerUid,
      mirrorVersion: MIRROR_VERSION,
      skillsCount,
    });
  } catch (err: any) {
    console.error("create-provider-account error:", err);
    return res.status(500).json({
      error: "Failed to create provider account.",
      code: err?.code || null,
      message: err?.message || null,
    });
  }
}
