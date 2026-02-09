// pages/api/mirror-provider-profile.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

const MIRROR_VERSION = "vercel-mirror-provider-profile-v1";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

/**
 * Keep skills structure EXACTLY (Flutter expects skills[0].education/certifications/jobExperience).
 */
function sanitizeSkills(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === "object").map((x) => x);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const FieldValue = admin.firestore.FieldValue;

  try {
    // Debug: which Firebase project is Admin connected to?
    const projectId =
      (admin.app().options as any)?.projectId ||
      process.env.GCLOUD_PROJECT ||
      process.env.FIREBASE_PROJECT_ID ||
      null;

    // 1) Verify contractor identity
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const contractorUid = decoded.uid;

    const userSnap = await admin.firestore().collection("users").doc(contractorUid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;

    if (role !== "contractor") {
      return res.status(403).json({ error: "Only contractors can mirror provider profiles." });
    }

    // 2) Body
    const { providerDocId = "" } = req.body || {};
    const providerId = String(providerDocId).trim();
    if (!providerId) return res.status(400).json({ error: "Missing providerDocId." });

    // 3) Read contractor provider doc (SOURCE OF TRUTH)
    const contractorProviderRef = admin
      .firestore()
      .collection("contractors")
      .doc(contractorUid)
      .collection("providers")
      .doc(providerId);

    const snap = await contractorProviderRef.get();
    if (!snap.exists) {
      return res.status(404).json({
        error: "Contractor provider doc not found.",
        contractorUid,
        providerDocId: providerId,
        projectId,
      });
    }

    const data = (snap.data() || {}) as Record<string, any>;

    const providerUid = String(data.providerUid ?? "").trim();
    if (!providerUid) {
      return res.status(400).json({
        error: "providerUid missing in contractor provider doc. (Account creation may have failed)",
        contractorUid,
        providerDocId: providerId,
        projectId,
      });
    }

    // 4) Prepare fields to mirror
    const firstName = String(data.firstName ?? "").trim();
    const lastName = String(data.lastName ?? "").trim();
    const email = String(data.email ?? "").trim().toLowerCase();
    const phone = String(data.phone ?? "").trim();
    const gender = String(data.gender ?? "").trim();

    const fullAddress =
      String(data.fullAddress ?? "").trim() || String(data.address ?? "").trim();

    const address1 = String(data.address1 ?? "").trim();
    const address2 = String(data.address2 ?? "").trim();
    const city = String(data.city ?? "").trim();

    const languages = sanitizeStringArray(data.languages);
    const categories = sanitizeStringArray(data.categories);
    const categoriesNormalized = sanitizeStringArray(data.categoriesNormalized);

    const skills = Array.isArray(data.skills) ? sanitizeSkills(data.skills) : [];
    const skillsCount = Array.isArray(skills) ? skills.length : 0;

    // Preserve existing GeoPoint and geocode fields if present
    const geoFields: Record<string, any> = {};
    if (data.location) geoFields.location = data.location;
    if (data.locationUpdatedAt) geoFields.locationUpdatedAt = data.locationUpdatedAt;
    if (data.geocode) geoFields.geocode = data.geocode;

    // Preserve profile image base64 (your app uses it)
    const profileImageBase64 = data.profileImageBase64 ?? null;

    const contractorRef = admin.firestore().doc(`contractors/${contractorUid}`);

    // 5) Mirror to serviceProviders/{providerUid}
    const spRef = admin.firestore().collection("serviceProviders").doc(providerUid);

    await spRef.set(
      {
        providerUid,
        providerEmail: email || undefined,
        managedBy: contractorRef,
        contractorId: contractorUid,

        firstName,
        lastName,
        phone: phone || undefined,
        gender: gender || undefined,

        address: {
          fullAddress: fullAddress || "",
          address1: address1 || undefined,
          address2: address2 || undefined,
          city: city || undefined,
        },

        languages,
        categories,
        categoriesNormalized,

        // ✅ THIS is what your UI reads for education/certs/jobExperience
        skills,

        profileImageBase64,

        mirrorVersion: MIRROR_VERSION,
        mirroredFromProviderDocId: providerId,
        skillsCount,
        mirroredAt: FieldValue.serverTimestamp(),

        ...geoFields,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 6) Read-back proof
    const spSnap = await spRef.get();
    const spData = spSnap.data() || {};
    const skillsCountInServiceProviders = Array.isArray(spData.skills) ? spData.skills.length : 0;

    return res.status(200).json({
      ok: true,
      projectId,
      contractorUid,
      providerDocId: providerId,
      providerUid,
      mirrorVersion: MIRROR_VERSION,
      skillsCountReadFromContractor: skillsCount,
      skillsCountInServiceProviders,
    });
  } catch (err: any) {
    console.error("mirror-provider-profile error:", err);
    return res.status(500).json({
      error: "Failed to mirror provider profile.",
      code: err?.code || null,
      message: err?.message || null,
    });
  }
}
