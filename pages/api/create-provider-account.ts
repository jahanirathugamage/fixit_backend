// pages/api/create-provider-account.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

interface ContractorProviderData {
  firstName?: string;
  lastName?: string;
  languages?: string[];
  skills?: unknown[]; // you can refine this later if you like
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // 1) Verify Firebase ID token from contractor
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

    // 2) Ensure caller is a contractor
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

    // 3) Validate body
    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
    } = (req.body || {}) as {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      providerDocId?: string;
    };

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

    // 4) Create auth user for provider
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    const providerUid = userRecord.uid;

    // 5) users/{providerUid} - role store
    await admin
      .firestore()
      .collection("users")
      .doc(providerUid)
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

    // 6) Link provider user to contractor's providers subcollection
    if (providerId) {
      await admin
        .firestore()
        .collection("contractors")
        .doc(callerUid)
        .collection("providers")
        .doc(providerId)
        .set(
          {
            providerUid,
          },
          { merge: true },
        );
    }

    // 7) Create top-level providers/{providerUid} doc for ProviderHomeRepository
    //
    // This is what your Flutter code reads:
    //   _firestore.collection('providers').doc(user.uid).get();
    //
    // Try to reuse data from contractors/{callerUid}/providers/{providerDocId}
    // if it exists, otherwise just write the basics.
    let contractorProviderData: ContractorProviderData = {};

    if (providerId) {
      const providerSnap = await admin
        .firestore()
        .collection("contractors")
        .doc(callerUid)
        .collection("providers")
        .doc(providerId)
        .get();

      if (providerSnap.exists) {
        contractorProviderData =
          (providerSnap.data() ?? {}) as ContractorProviderData;
      }
    }

    const providerProfile = {
      firstName: fName || contractorProviderData.firstName || "",
      lastName: lName || contractorProviderData.lastName || "",
      email: mail,
      contractorId: callerUid,
      contractorProviderDocId: providerId || null,
      languages: contractorProviderData.languages || [],
      skills: contractorProviderData.skills || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await admin
      .firestore()
      .collection("providers")
      .doc(providerUid)
      .set(providerProfile, { merge: true });

    // 8) Send email with login details
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
    res.status(200).json({ ok: true, providerUid });
  } catch (err: unknown) {
    console.error("create-provider-account error:", err);
    res.status(500).json({ error: "Failed to create provider account." });
  }
}
