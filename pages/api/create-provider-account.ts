// relative path: pages/api/create-provider-account.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

function normalizeAddress(input: string): string {
  const raw = String(input || "").trim();

  // split, trim, remove empties
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);

  // remove duplicate consecutive parts (e.g. "Sri Lanka, Sri Lanka")
  const deduped: string[] = [];
  for (const p of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()) {
      deduped.push(p);
    }
  }

  return deduped.join(", ");
}


function setCors(res: NextApiResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

type Geo = { lat: number; lng: number };
type GeocodeMeta = {
  source: "nominatim";
  query: string;
  displayName?: string | null;
};

async function geocodeAddress(address: string): Promise<{ geo: Geo; meta: GeocodeMeta } | null> {
  const query = address.trim();
  if (query.length < 6) return null;

  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(query)}` +
    "&format=json&limit=1&addressdetails=1&countrycodes=lk";

  try {
    const resp = await fetch(url, {
      headers: {
        // ⚠️ Put something identifying here (recommended by Nominatim usage policy)
        "User-Agent": "FixIt-Academic-Project/1.0 (geocoding; contact: your-email@example.com)",
        Accept: "application/json",
        "Accept-Language": "en",
      },
    });

    if (!resp.ok) {
      console.error(`Nominatim HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
    }>;

    if (!Array.isArray(data) || data.length === 0) return null;

    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      geo: { lat, lng },
      meta: {
        source: "nominatim",
        query,
        displayName: data[0].display_name ?? null,
      },
    };
  } catch (e) {
    console.error("Nominatim fetch failed:", e);
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const FieldValue = admin.firestore.FieldValue;

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
      languages = [],
      skills = [],
    } = req.body || {};

    const mail = String(email).trim().toLowerCase();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim(); // contractor subcollection doc id
    const fullAddress = normalizeAddress(address).trim();

    const langs = Array.isArray(languages) ? languages : [];
    const sks = Array.isArray(skills) ? skills : [];

    if (!mail || !mail.includes("@")) {
      return res.status(400).json({ error: "Invalid email." });
    }
    if (!pw || pw.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    // If your flow ALWAYS creates provider details under contractor first, you probably want this required:
    if (!providerId) {
      return res.status(400).json({ error: "Missing providerDocId (contractor providers doc id)." });
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
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const contractorRef = admin.firestore().doc(`contractors/${callerUid}`);
    const userRef = admin.firestore().doc(`users/${providerUid}`);

    // ---- Geocode address (best-effort) ----
    // const geocoded = await geocodeAddress(fullAddress);
    // let geo: Geo | null = null;

    // const geoFields: Record<string, any> = {};
    // if (geocoded) {
    //   geo = geocoded.geo;
    //   geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng); // ✅ Firestore GeoPoint
    //   geoFields.geocode = {
    //     ...geocoded.meta,
    //     updatedAt: FieldValue.serverTimestamp(),
    //   };
    //   geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
    // }

    const geocoded = await geocodeAddress(fullAddress);
    let geo: Geo | null = null;

    const geoFields: Record<string, any> = {
      geocode: {
        source: "nominatim",
        query: fullAddress,
        status: "no_results",
        updatedAt: FieldValue.serverTimestamp(),
      },
    };

    if (geocoded) {
      geo = geocoded.geo;
      geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
      geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
      geoFields.geocode = {
        ...geocoded.meta,
        status: "ok",
        updatedAt: FieldValue.serverTimestamp(),
      };
    }


    // ---- 1) Save/merge provider details under contractor first ----
    // contractors/{contractorUid}/providers/{providerDocId}
    await admin
      .firestore()
      .collection("contractors")
      .doc(callerUid)
      .collection("providers")
      .doc(providerId)
      .set(
        {
          providerUid,
          email: mail,
          firstName: fName,
          lastName: lName,
          address: fullAddress || "",
          languages: langs,
          skills: sks,
          managedBy: contractorRef,
          updatedAt: FieldValue.serverTimestamp(),
          ...geoFields, // ✅ also store location/geocode here if you want
        },
        { merge: true },
      );

    // ---- 2) Mirror the queryable row into serviceProviders/{providerUid} ----
    await admin.firestore().collection("serviceProviders").doc(providerUid).set(
      {
        providerEmail: mail,
        providerId: userRef,
        managedBy: contractorRef,

        // keep your current address structure
        address: {
          fullAddress: fullAddress || "",
        },

        // mirror useful matching fields (optional)
        firstName: fName,
        lastName: lName,
        languages: langs,
        // skills: sks,

        ...geoFields, // ✅ location + geocode + locationUpdatedAt
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

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

    return res.status(200).json({ ok: true, providerUid, geo, version: "svcProviders-v2" });
  } catch (err: any) {
    console.error("create-provider-account error:", err);

    //Firebase Admin errors often have these fields
    const code = err.code || null;
    const message = err.message || null;

    return res.status(500).json({ 
      error: "Failed to create provider account.",
      code,
      message, });
  }
}
