// pages/api/reject-contractor.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!idToken) {
      res.status(401).json({ error: "Missing auth token" });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    // Only admin can reject contractor
    const adminDoc = await admin
      .firestore()
      .collection("users")
      .doc(callerUid)
      .get();

    if (!adminDoc.exists || adminDoc.data()?.role !== "admin") {
      res.status(403).json({ error: "Only admins can reject contractors." });
      return;
    }

    const {
      contractorId = "",
      rejectionReason = "",
    }: { contractorId?: string; rejectionReason?: string } = req.body || {};

    const contractorUid = String(contractorId).trim();
    if (!contractorUid) {
      res.status(400).json({ error: "Missing contractorId." });
      return;
    }

    const cleanReason =
      rejectionReason && rejectionReason.trim() !== ""
        ? rejectionReason.trim()
        : "No specific reason was provided.";

    // Update contractor document
    const contractorRef = admin
      .firestore()
      .collection("contractors")
      .doc(contractorUid);

    const contractorSnap = await contractorRef.get();
    if (!contractorSnap.exists) {
      res.status(404).json({ error: "Contractor not found." });
      return;
    }

    const contractorData = contractorSnap.data() || {};
    const companyName =
      (contractorData.companyName as string | undefined) || "your firm";

    await contractorRef.update({
      approvalStatus: "rejected",
      rejectionReason: cleanReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Find email: prefer companyEmail on contractor doc, else users/{uid}.email
    let email: string | null =
      (contractorData.companyEmail as string | undefined) || null;

    if (!email) {
      const userSnap = await admin
        .firestore()
        .collection("users")
        .doc(contractorUid)
        .get();
      if (userSnap.exists) {
        email = (userSnap.data()?.email as string | undefined) || null;
      }
    }

    if (!email) {
      console.log("No email found for contractor", contractorUid);
      res.status(200).json({ ok: true, note: "No email found for contractor." });
      return;
    }

    const subject = "Your FixIt contractor registration was rejected";
    const text =
      "Hello,\n\n" +
      "We’re sorry to inform you that your contractor registration " +
      `for "${companyName}" has been rejected.\n\n` +
      "Reason:\n" +
      `${cleanReason}\n\n` +
      "You may re-apply after addressing the above issues.\n\n" +
      "– FixIt Team";

    await sendEmail(email, subject, text);

    console.log("Rejection email sent to", email);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("reject-contractor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
