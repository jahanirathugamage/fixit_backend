import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

const RESYNC_VERSION = "vercel-resync-provider-mirror-v1";

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
      return res.status(403).json({ error: "Only contractors can resync provider mirrors." });
    }

    const { providerDocId = "" } = req.body || {};
    const providerId = String(providerDocId).trim();
    if (!providerId) return res.status(400).json({ error: "Missing providerDocId." });

    // Read contractor provider doc
    const contractorProviderRef = admin
      .firestore()
      .collection("contractors")
      .doc(callerUid)
      .collection("providers")
      .doc(providerId);

    const snap = await contractorProviderRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Contractor provider doc not found." });

    const data = snap.data() as Record<string, any>;
    const providerUid = String(data?.providerUid || "").trim();
    if (!providerUid) return res.status(400).json({ error: "providerUid missing in contractor provider doc." });

    const skills = sanitizeSkills(data?.skills);
    const skillsCount = skills.length;

    // Mirror ONLY what you need (skills) + proof fields
    await admin.firestore().collection("serviceProviders").doc(providerUid).set(
      {
        skills,
        skillsCount,
        resyncVersion: RESYNC_VERSION,
        resyncedFromProviderDocId: providerId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      providerUid,
      skillsCount,
      resyncVersion: RESYNC_VERSION,
    });
  } catch (err: any) {
    console.error("resync-provider-mirror error:", err);
    return res.status(500).json({
      error: "Failed to resync provider mirror.",
      code: err?.code || null,
      message: err?.message || null,
    });
  }
}
