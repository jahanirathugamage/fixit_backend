// pages/api/admin-approve.ts
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto"; // only if you want random pw; already used
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const tokenParam = req.query.token;
    const token =
      typeof tokenParam === "string" ? tokenParam : String(tokenParam || "");

    if (!token) {
      res.status(400).send("Missing or invalid token.");
      return;
    }

    const inviteRef = admin.firestore().collection("adminInvites").doc(token);
    const snap = await inviteRef.get();

    if (!snap.exists) {
      res.status(400).send("Invalid or expired invitation.");
      return;
    }

    const data = snap.data() || {};

    if (data.status === "approved") {
      res.send("This invitation has already been approved.");
      return;
    }

    const firstName = (data.firstName as string) || "";
    const lastName = (data.lastName as string) || "";
    const email = (data.email as string) || "";

    // Random initial password
    const password = crypto.randomBytes(9).toString("base64").slice(0, 12);

    // Create auth user
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`.trim(),
    });

    // users/{uid}
    await admin
      .firestore()
      .collection("users")
      .doc(userRecord.uid)
      .set({
        role: "admin",
        firstName,
        lastName,
        email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // admins/{uid}
    await admin
      .firestore()
      .collection("admins")
      .doc(userRecord.uid)
      .set({
        firstName,
        lastName,
        email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Mark invite as approved
    await inviteRef.update({
      status: "approved",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      adminUid: userRecord.uid,
    });

    const text =
      `Hi ${firstName},\n\n` +
      "Your admin account has been approved.\n\n" +
      "You can now log in with:\n\n" +
      `Email: ${email}\n` +
      `Password: ${password}\n\n` +
      "For security, please log in and change your password immediately.\n\n" +
      "– FixIt Team";

    await sendEmail(email, "Your FixIt admin account", text);

    res.send(
      "Your admin account has been created. Please check your email for login details.",
    );
  } catch (err) {
    console.error("admin-approve error:", err);
    res.status(500).send("Internal server error");
  }
}
