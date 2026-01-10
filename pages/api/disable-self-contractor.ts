// pages/api/disable-self-contractor.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      res.status(401).json({ error: "Missing auth token" });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    // Caller must be a contractor (role check in users/{uid})
    const userDoc = await admin.firestore().collection("users").doc(callerUid).get();
    if (!userDoc.exists || userDoc.data()?.role !== "contractor") {
      res.status(403).json({ error: "Only contractors can disable their own account." });
      return;
    }

    // Disable Auth user — blocks sign-in until admin approves (approve-contractor enables)
    await admin.auth().updateUser(callerUid, { disabled: true });

    // Optional: you can also mirror a canonical status field here (merge-safe)
    await admin.firestore().collection("contractors").doc(callerUid).set(
      {
        approvalStatus: "pending",
        verified: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("disable-self-contractor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
