// pages/api/create-provider-account.ts
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
    // Firebase ID token
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

    // Caller must be contractor
    const userSnap = await admin
      .firestore()
      .collection("users")
      .doc(callerUid)
      .get();

    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;
    if (role !== "contractor") {
      res
        .status(403)
        .json({ error: "Only contractors can create provider accounts." });
      return;
    }

    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
    } = req.body || {};

    const mail = String(email).trim();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim();

    if (!mail || !mail.includes("@") || !pw || pw.length < 6) {
      res.status(400).json({ error: "Invalid email or password." });
      return;
    }

    console.log(
      "Creating provider account for email:",
      mail,
      "contractor:",
      callerUid,
      "providerDocId:",
      providerId,
    );

    // Create auth user
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    // users/{uid}
    await admin
      .firestore()
      .collection("users")
      .doc(userRecord.uid)
      .set(
        {
          role: "provider",
          firstName: fName,
          lastName: lName,
          email: mail,
          contractorId: callerUid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    // Link in contractors/{callerUid}/providers/{providerDocId}
    if (providerId) {
      await admin
        .firestore()
        .collection("contractors")
        .doc(callerUid)
        .collection("providers")
        .doc(providerId)
        .set(
          {
            providerUid: userRecord.uid,
          },
          { merge: true },
        );
    }

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

    console.log("Provider account created and email sent to", mail);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("create-provider-account error:", err);
    res.status(500).json({ error: "Failed to create provider account." });
  }
}
