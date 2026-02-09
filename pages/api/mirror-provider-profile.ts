// pages/api/mirror-provider-profile.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

const MIRROR_VERSION = "vercel-mirror-provider-profile-v1";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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
    // Verify contractor identity
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const userSnap = await admin.firestore().collection("users").doc(callerUid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;
    if (role !== "contractor") {
      return res.status(403).json({ error: "Only contractors can mirror provider profiles." });
    }

    const { providerDocId = "", providerUid = "" } = req.body || {};
    const providerId = String(providerDocId).trim();
    const pUid = String(providerUid).trim();

    if (!providerId) return res.status(400).json({ error: "Missing providerDocId." });
    if (!pUid) return res.status(400).json({ error: "Missing providerUid." });

    const contractorProviderRef = admin
      .firestore()
      .collection("contractors")
      .doc(callerUid)
      .collection("providers")
      .doc(providerId);

    const contractorProviderSnap = await contractorProviderRef.get();
    if (!contractorProviderSnap.exists) {
      return res.status(404).json({ error: "Contractor provider doc not found." });
    }

    const data = contractorProviderSnap.data() as Record<string, any>;

    const finalSkills =
      Array.isArray(data.skills) && data.skills.length > 0 ? sanitizeSkills(data.skills) : [];
    const skillsCount = Array.isArray(finalSkills) ? finalSkills.length : 0;

    // Copy ONLY what clients/providers need
    const mirrorPayload: Record<string, any> = {
      providerUid: pUid,
      contractorId: callerUid,
      firstName: data.firstName ?? "",
      lastName: data.lastName ?? "",
      languages: Array.isArray(data.languages) ? data.languages : [],
      categories: Array.isArray(data.categories) ? data.categories : [],
      categoriesNormalized: Array.isArray(data.categoriesNormalized) ? data.categoriesNormalized : [],
      location: data.location ?? null,
      locationUpdatedAt: data.locationUpdatedAt ?? null,
      geocode: data.geocode ?? null,

      // ✅ key fix
      skills: finalSkills,

      mirrorVersion: MIRROR_VERSION,
      mirroredFromProviderDocId: providerId,
      skillsCount,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Optional address format (keep what you already use)
    if (typeof data.fullAddress === "string") {
      mirrorPayload.address = { fullAddress: data.fullAddress };
    } else if (typeof data.address === "string") {
      mirrorPayload.address = { fullAddress: data.address };
    }

    await admin.firestore().collection("serviceProviders").doc(pUid).set(mirrorPayload, {
      merge: true,
    });

    return res.status(200).json({
      ok: true,
      providerUid: pUid,
      skillsCount,
      mirrorVersion: MIRROR_VERSION,
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
