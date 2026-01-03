// pages/api/reject-contractor.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function deleteQueryInBatches(query: FirebaseFirestore.Query) {
  while (true) {
    const snap = await query.limit(450).get();
    if (snap.empty) break;

    const batch = admin.firestore().batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}

async function deleteContractorRelatedServiceProviders(contractorUid: string) {
  const db = admin.firestore();

  await deleteQueryInBatches(
    db.collection("serviceProviders").where("contractorId", "==", contractorUid),
  );

  await deleteQueryInBatches(
    db.collection("providers").where("contractorId", "==", contractorUid),
  );

  const subSnap = await db
    .collection("contractors")
    .doc(contractorUid)
    .collection("providers")
    .limit(1)
    .get();

  if (!subSnap.empty) {
    await deleteQueryInBatches(
      db.collection("contractors").doc(contractorUid).collection("providers"),
    );
  }
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

    const contractorRef = admin.firestore().collection("contractors").doc(contractorUid);
    const contractorSnap = await contractorRef.get();

    if (!contractorSnap.exists) {
      res.status(404).json({ error: "Contractor not found." });
      return;
    }

    const contractorData = contractorSnap.data() || {};
    const companyName =
      (contractorData.companyName as string | undefined) || "your firm";

    let email: string | null =
      (contractorData.companyEmail as string | undefined) || null;

    if (!email) {
      const userSnap = await admin.firestore().collection("users").doc(contractorUid).get();
      if (userSnap.exists) {
        email = (userSnap.data()?.email as string | undefined) || null;
      }
    }

    // 1) mark rejected first (optional UI visibility)
    await contractorRef.set(
      {
        approvalStatus: "rejected",
        rejectionReason: cleanReason,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 2) send email (best effort)
    if (email) {
      const subject = "Your FixIt contractor registration was rejected";
      const text =
        "Hello,\n\n" +
        "We’re sorry to inform you that your contractor registration " +
        `for "${companyName}" has been rejected.\n\n` +
        "Reason:\n" +
        `${cleanReason}\n\n` +
        "You may re-apply after addressing the above issues.\n\n" +
        "– FixIt Team";

      try {
        await sendEmail(email, subject, text);
        console.log("Rejection email sent to", email);
      } catch (e) {
        console.warn("reject-contractor: email send failed:", e);
      }
    } else {
      console.warn("reject-contractor: No email found for contractor", contractorUid);
    }

    // 3) delete ONLY contractor-related service providers
    try {
      await deleteContractorRelatedServiceProviders(contractorUid);
    } catch (e) {
      console.error("reject-contractor: failed deleting related service providers:", e);
    }

    // 4) delete docs
    try {
      await contractorRef.delete();
    } catch (e) {
      console.error("reject-contractor: failed deleting contractors/{uid}:", e);
    }

    try {
      await admin.firestore().collection("users").doc(contractorUid).delete();
    } catch (e) {
      console.error("reject-contractor: failed deleting users/{uid}:", e);
    }

    // 5) delete auth user
    try {
      await admin.auth().deleteUser(contractorUid);
    } catch (e) {
      console.error("reject-contractor: deleteUser failed (maybe already deleted):", e);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("reject-contractor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
