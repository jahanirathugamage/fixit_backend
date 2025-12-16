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

function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type Geo = { lat: number; lng: number };

/**
 * OpenStreetMap (Nominatim) geocoding
 * - No API key, no billing
 * - IMPORTANT: Nominatim requires identifying User-Agent
 */
async function geocodeAddress(address: string): Promise<Geo> {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address)}` +
    "&format=json" +
    "&limit=1" +
    "&addressdetails=0";

  const resp = await fetch(url, {
    headers: {
      // Put something identifying here. If you have a support email, use it.
      "User-Agent": "FixIt-Academic-Project (geocoding)",
      "Accept-Language": "en",
    },
  });

  if (!resp.ok) {
    throw new Error(`Nominatim HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as Array<{ lat: string; lon: string }>;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Address could not be geocoded (no results)");
  }

  return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ---- Auth: require contractor caller ----
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const userSnap = await admin.firestore().collection("users").doc(callerUid).get();
    const role = userSnap.exists ? (userSnap.data()?.role as string) : null;
    if (role !== "contractor") {
      return res.status(403).json({ error: "Only contractors can create provider accounts." });
    }

    // ---- Body ----
    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
      address = "",
    } = req.body || {};

    const mail = String(email).trim();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim();
    const fullAddress = String(address).trim();

    if (!mail || !mail.includes("@") || !pw || pw.length < 6) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    // ---- Create Auth user ----
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    const providerUid = userRecord.uid;

    // ---- Base user profile ----
    await admin.firestore().collection("users").doc(providerUid).set(
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

    // ---- Link provider to contractor's subcollection (if providerDocId provided) ----
    if (providerId) {
      await admin
        .firestore()
        .collection("contractors")
        .doc(callerUid)
        .collection("providers")
        .doc(providerId)
        .set({ providerUid }, { merge: true });
    }

    // ---- Geocode address (optional) ----
    let geo: Geo | null = null;

    if (fullAddress.length > 5) {
      try {
        geo = await geocodeAddress(fullAddress);

        // Save geocoded location to provider docs (so app can use it later)
        const geoPoint = new admin.firestore.GeoPoint(geo.lat, geo.lng);

        // Recommended: top-level providers/{providerUid}
        await admin.firestore().collection("providers").doc(providerUid).set(
          {
            providerUid,
            address: fullAddress,
            location: geoPoint,
            locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            managedBy: admin.firestore().doc(`contractors/${callerUid}`),
          },
          { merge: true },
        );

        // Optional: if you also use serviceProviders/{providerUid} as "master table"
        await admin.firestore().collection("serviceProviders").doc(providerUid).set(
          {
            providerEmail: mail,
            providerId: admin.firestore().doc(`users/${providerUid}`),
            managedBy: admin.firestore().doc(`contractors/${callerUid}`),
            address: {
              fullAddress,
            },
            location: geoPoint,
            locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (e) {
        console.error("Geocoding failed:", e);
        // We still proceed (account created), geo stays null
      }
    }

    // ---- Email provider their credentials ----
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

    return res.status(200).json({ ok: true, providerUid, geo });
  } catch (err) {
    console.error("create-provider-account error:", err);
    return res.status(500).json({ error: "Failed to create provider account." });
  }
}
