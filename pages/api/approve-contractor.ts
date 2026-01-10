// pages/api/approve-contractor.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  // ✅ Handle browser preflight (CORS)
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

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

    const adminDoc = await admin.firestore().collection("users").doc(callerUid).get();
    if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
      res.status(403).json({ error: "Only admins can approve contractors." });
      return;
    }

    const {
      contractorId = "",
      approvalNote = "",
    }: { contractorId?: string; approvalNote?: string } = req.body || {};

    const contractorUid = String(contractorId).trim();
    if (!contractorUid) {
      res.status(400).json({ error: "Missing contractorId." });
      return;
    }

    const cleanNote = String(approvalNote || "").trim();

    const contractorRef = admin.firestore().collection("contractors").doc(contractorUid);
    const contractorSnap = await contractorRef.get();

    if (!contractorSnap.exists) {
      res.status(404).json({ error: "Contractor not found." });
      return;
    }

    const contractorData = contractorSnap.data() || {};
    const companyName =
      (contractorData.companyName as string | undefined) || "your firm";

    await contractorRef.set(
    {
      approvalStatus: "approved",

      // ✅ add these for compatibility with your existing Flutter queries
      verified: true,
      status: "approved",
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),

      approvalNote: cleanNote,
      rejectionReason: admin.firestore.FieldValue.delete(),
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );


    await admin.firestore().collection("users").doc(contractorUid).set(
      {
        role: "contractor",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // enable auth (if you disabled at registration time)
    try {
      await admin.auth().updateUser(contractorUid, { disabled: false });
    } catch (e) {
      console.warn("approve-contractor: updateUser failed:", e);
    }

    // email (best effort)
    let email: string | null =
      (contractorData.companyEmail as string | undefined) || null;

    if (!email) {
      const userSnap = await admin.firestore().collection("users").doc(contractorUid).get();
      if (userSnap.exists) {
        email = (userSnap.data()?.email as string | undefined) || null;
      }
    }

    if (email) {
      const subject = "Your FixIt Contractor Registration was approved";
      const text =
        "Hello,\n\n" +
        `Good news! Your contractor registration for "${companyName}" has been approved.\n\n` +
        "You can now sign in and access the contractor dashboard.\n\n" +
        "– FixIt Team";

      try {
        await sendEmail(email, subject, text);
      } catch (e) {
        console.warn("approve-contractor: email send failed:", e);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("approve-contractor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
