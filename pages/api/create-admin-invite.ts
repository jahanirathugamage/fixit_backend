// pages/api/create-admin-invite.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
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
    // Get Firebase ID token from Authorization: Bearer <token>
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

    // Check caller is admin
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(callerUid)
      .get();

    if (!userDoc.exists || userDoc.data()?.role !== "admin") {
      res.status(403).json({ error: "Only admins can create other admins." });
      return;
    }

    const { firstName = "", lastName = "", email = "" } = req.body || {};
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const mail = String(email).trim();

    if (!fName || !lName || !mail || !mail.includes("@")) {
      res.status(400).json({ error: "Invalid name or email." });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");

    const inviteRef = admin.firestore().collection("adminInvites").doc(token);
    await inviteRef.set({
      firstName: fName,
      lastName: lName,
      email: mail,
      createdBy: callerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "pending",
    });

    // TODO: replace YOUR_VERCEL_DOMAIN with your real deployed domain
    const approvalLink = `https://fixit-backend-pink.vercel.app/api/admin-approve?token=${token}`;

    const text =
      `Hi ${fName},\n\n` +
      "You have been invited to become an administrator at FixIt.\n\n" +
      "Please click the link below to approve and activate your admin account:\n\n" +
      `${approvalLink}\n\n` +
      "If you did not expect this invite, you can ignore this email.\n";

    await sendEmail(mail, "FixIt admin approval link", text);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("create-admin-invite error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
