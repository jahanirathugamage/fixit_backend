// pages/api/create-provider-account.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";
import axios from "axios";

// ✅ CORS helper
function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function geocodeAddress(address: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY env var on Vercel");

  const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
    params: { address, key },
  });

  if (!resp.data?.results?.length) {
    throw new Error("Address could not be geocoded");
  }

  const loc = resp.data.results[0].geometry.location; // { lat, lng }
  return { lat: loc.lat, lng: loc.lng };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  // ✅ Handle preflight
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Firebase ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      res.status(401).json({ error: "Missing auth token" });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    // Caller must be contractor
    const userSnap = await admin.firestore().collection("users").doc(callerUid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;

    if (role !== "contractor") {
      res.status(403).json({ error: "Only contractors can create provider accounts." });
      return;
    }

    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
      address = "", // ✅ accept address
    } = req.body || {};

    const mail = String(email).trim();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim();
    const addr = String(address).trim();

    if (!mail || !mail.includes("@") || !pw || pw.length < 6) {
      res.status(400).json({ error: "Invalid email or password." });
      return;
    }

    // ✅ geocode (optional but recommended)
    let geo: { lat: number; lng: number } | null = null;
    if (addr) {
      try {
        geo = await geocodeAddress(addr);
      } catch (e) {
        console.error("Geocoding failed:", e);
        // don’t fail provider creation if geocode fails
        geo = null;
      }
    }

    // Create auth user
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    // users/{uid}
    await admin.firestore().collection("users").doc(userRecord.uid).set(
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

    // Link back to contractors/{callerUid}/providers/{providerDocId}
    if (providerId) {
      await admin
        .firestore()
        .collection("contractors")
        .doc(callerUid)
        .collection("providers")
        .doc(providerId)
        .set({ providerUid: userRecord.uid }, { merge: true });
    }

    // Email provider
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

    // ✅ Return providerUid + geo to Flutter
    res.status(200).json({ ok: true, providerUid: userRecord.uid, geo });
  } catch (err) {
    console.error("create-provider-account error:", err);
    res.status(500).json({ error: "Failed to create provider account." });
  }
}
