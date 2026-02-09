/* eslint-disable @typescript-eslint/no-explicit-any */

// import type { NextApiRequest, NextApiResponse } from "next";
// import { admin } from "@/lib/firebaseAdmin";
// import { sendEmail } from "@/lib/mailer";

// function normalizeAddress(input: string): string {
//   const raw = String(input || "").trim();
//   const parts = raw
//     .split(",")
//     .map((p) => p.trim())
//     .filter(Boolean);

//   // Remove consecutive duplicates (e.g. "Sri Lanka, Sri Lanka")
//   const deduped: string[] = [];
//   for (const p of parts) {
//     if (
//       deduped.length === 0 ||
//       deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()
//     ) {
//       deduped.push(p);
//     }
//   }

//   return deduped.join(", ");
// }

// function setCors(res: NextApiResponse) {
//   res.setHeader("Access-Control-Allow-Origin", "*");
//   res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
// }

// type Geo = { lat: number; lng: number };

// type GeocodeMeta = {
//   source: "nominatim" | "pin";
//   query: string;
//   displayName?: string | null;
//   status: "ok" | "no_results" | "pin";
//   updatedAt: admin.firestore.FieldValue;
// };

// /**
//  * Safely converts unknown input into a clean array of strings.
//  * - Trims whitespace
//  * - Removes empty values
//  * - Deduplicates (case-insensitive)
//  */
// function sanitizeStringArray(raw: any): string[] {
//   if (!Array.isArray(raw)) return [];
//   const cleaned = raw
//     .map((v) => String(v ?? "").trim())
//     .filter((v) => v.length > 0);

//   const deduped: string[] = [];
//   const seen = new Set<string>();
//   for (const v of cleaned) {
//     const key = v.toLowerCase();
//     if (!seen.has(key)) {
//       seen.add(key);
//       deduped.push(v);
//     }
//   }
//   return deduped;
// }

// function parsePinnedLocation(raw: any): Geo | null {
//   if (!raw || typeof raw !== "object") return null;

//   const lat = Number((raw as any).lat);
//   const lng = Number((raw as any).lng);

//   if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
//   if (lat < -90 || lat > 90) return null;
//   if (lng < -180 || lng > 180) return null;

//   return { lat, lng };
// }

// async function geocodeAddress(
//   address: string,
// ): Promise<{ geo: Geo; meta: { query: string; displayName?: string | null } } | null> {
//   const query = String(address || "").trim();
//   if (query.length < 6) return null;

//   async function callNominatim(q: string) {
//     const url =
//       "https://nominatim.openstreetmap.org/search" +
//       `?q=${encodeURIComponent(q)}` +
//       "&format=json&limit=3&addressdetails=1" +
//       "&countrycodes=lk";

//     const resp = await fetch(url, {
//       headers: {
//         "User-Agent":
//           "FixIt-Academic-Project/1.0 (geocoding; contact: your-email@example.com)",
//         Accept: "application/json",
//         "Accept-Language": "en",
//       },
//     });

//     if (!resp.ok) {
//       console.error(`Nominatim HTTP ${resp.status}`);
//       return [] as Array<{ lat: string; lon: string; display_name?: string }>;
//     }

//     const data = (await resp.json()) as Array<{
//       lat: string;
//       lon: string;
//       display_name?: string;
//     }>;

//     return Array.isArray(data) ? data : [];
//   }

//   try {
//     let data = await callNominatim(query);

//     // If no results, try removing house number from the beginning as a fallback
//     if (!data.length) {
//       const fallback = query
//         .replace(/^\s*(no\.?\s*)?\d+[a-zA-Z0-9\/-]*\s*,\s*/i, "")
//         .trim();

//       if (fallback && fallback !== query) {
//         data = await callNominatim(fallback);
//       }
//     }

//     if (!data.length) return null;

//     const lat = Number(data[0].lat);
//     const lng = Number(data[0].lon);
//     if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

//     return {
//       geo: { lat, lng },
//       meta: {
//         query,
//         displayName: data[0].display_name ?? null,
//       },
//     };
//   } catch (e) {
//     console.error("Nominatim fetch failed:", e);
//     return null;
//   }
// }

// export default async function handler(req: NextApiRequest, res: NextApiResponse) {
//   setCors(res);

//   if (req.method === "OPTIONS") return res.status(204).end();
//   if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

//   const FieldValue = admin.firestore.FieldValue;

//   try {
//     // -----------------------------
//     // 1) Verify contractor identity
//     // -----------------------------
//     const authHeader = req.headers.authorization || "";
//     const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
//     if (!idToken) return res.status(401).json({ error: "Missing auth token" });

//     const decoded = await admin.auth().verifyIdToken(idToken);
//     const callerUid = decoded.uid;

//     const userSnap = await admin.firestore().collection("users").doc(callerUid).get();
//     const role = userSnap.exists ? (userSnap.data()?.role as string) : null;

//     if (role !== "contractor") {
//       return res.status(403).json({ error: "Only contractors can create provider accounts." });
//     }

//     // -----------------------------
//     // 2) Read request body
//     // -----------------------------
//     const {
//       email = "",
//       password = "",
//       firstName = "",
//       lastName = "",
//       providerDocId = "",
//       address = "",
//       languages = [],
//       skills = [],
//       // OPTIONAL: if you ever decide to send these from client
//       categories = [],
//       categoriesNormalized = [],
//       location = null, // ✅ {lat,lng} from pinned map
//     } = req.body || {};

//     const mail = String(email).trim().toLowerCase();
//     const pw = String(password).trim();
//     const fName = String(firstName).trim();
//     const lName = String(lastName).trim();
//     const providerId = String(providerDocId).trim();
//     const fullAddress = normalizeAddress(address).trim();

//     const langs = Array.isArray(languages) ? languages : [];
//     const sks = Array.isArray(skills) ? skills : [];

//     if (!mail || !mail.includes("@")) {
//       return res.status(400).json({ error: "Invalid email." });
//     }
//     if (!pw || pw.length < 6) {
//       return res.status(400).json({ error: "Password must be at least 6 characters." });
//     }
//     if (!providerId) {
//       return res.status(400).json({
//         error: "Missing providerDocId (contractor providers doc id).",
//       });
//     }

//     // ---------------------------------------------------------
//     // 3) IMPORTANT: Fetch provider subdoc to get categories fields
//     //    This is the most reliable source in Option A, because
//     //    Flutter already saved categories into contractors/{uid}/providers/{docId}
//     // ---------------------------------------------------------
//     const contractorProviderRef = admin
//       .firestore()
//       .collection("contractors")
//       .doc(callerUid)
//       .collection("providers")
//       .doc(providerId);

//     const contractorProviderSnap = await contractorProviderRef.get();
//     const contractorProviderData = contractorProviderSnap.exists
//       ? (contractorProviderSnap.data() as Record<string, any>)
//       : {};

//     // Prefer Firestore values (source of truth), fallback to body (optional)
//     const finalCategories =
//       sanitizeStringArray(contractorProviderData?.categories).length > 0
//         ? sanitizeStringArray(contractorProviderData?.categories)
//         : sanitizeStringArray(categories);

//     const finalCategoriesNormalized =
//       sanitizeStringArray(contractorProviderData?.categoriesNormalized).length > 0
//         ? sanitizeStringArray(contractorProviderData?.categoriesNormalized)
//         : sanitizeStringArray(categoriesNormalized);

//     // -----------------------------
//     // 4) Create Auth user
//     // -----------------------------
//     const userRecord = await admin.auth().createUser({
//       email: mail,
//       password: pw,
//       displayName: `${fName} ${lName}`.trim() || undefined,
//     });

//     const providerUid = userRecord.uid;

//     // -----------------------------
//     // 5) Create/merge users/{providerUid}
//     // -----------------------------
//     await admin.firestore().collection("users").doc(providerUid).set(
//       {
//         role: "provider",
//         firstName: fName,
//         lastName: lName,
//         email: mail,
//         contractorId: callerUid,
//         createdAt: FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     const contractorRef = admin.firestore().doc(`contractors/${callerUid}`);
//     const userRef = admin.firestore().doc(`users/${providerUid}`);

//     // -----------------------------
//     // 6) Determine GeoPoint (pin > nominatim > none)
//     // -----------------------------
//     const pinned = parsePinnedLocation(location);

//     let geo: Geo | null = null;
//     const geoFields: Record<string, any> = {};

//     if (pinned) {
//       geo = pinned;
//       geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
//       geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
//       geoFields.geocode = {
//         source: "pin",
//         query: fullAddress || "",
//         displayName: null,
//         status: "pin",
//         updatedAt: FieldValue.serverTimestamp(),
//       } satisfies GeocodeMeta;
//     } else {
//       geoFields.geocode = {
//         source: "nominatim",
//         query: fullAddress || "",
//         displayName: null,
//         status: "no_results",
//         updatedAt: FieldValue.serverTimestamp(),
//       } satisfies GeocodeMeta;

//       const geocoded = await geocodeAddress(fullAddress);
//       if (geocoded) {
//         geo = geocoded.geo;
//         geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
//         geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
//         geoFields.geocode = {
//           source: "nominatim",
//           query: geocoded.meta.query,
//           displayName: geocoded.meta.displayName ?? null,
//           status: "ok",
//           updatedAt: FieldValue.serverTimestamp(),
//         } satisfies GeocodeMeta;
//       }
//     }

//     // -----------------------------
//     // 7) Update contractor subdoc (ensure providerUid + geo + categories are present)
//     //    NOTE: merge:true ensures we do NOT wipe existing fields.
//     // -----------------------------
//     await contractorProviderRef.set(
//       {
//         providerUid,
//         email: mail,
//         firstName: fName,
//         lastName: lName,
//         address: fullAddress || "",
//         languages: langs,
//         skills: sks,
//         managedBy: contractorRef,
//         updatedAt: FieldValue.serverTimestamp(),

//         // ✅ Ensure categories are present
//         categories: finalCategories,
//         categoriesNormalized: finalCategoriesNormalized,

//         ...geoFields,
//       },
//       { merge: true },
//     );

//     // -----------------------------
//     // 8) Mirror into serviceProviders/{providerUid}
//     //    This is what Matching will read.
//     // -----------------------------
//     await admin.firestore().collection("serviceProviders").doc(providerUid).set(
//       {
//         providerUid,
//         providerEmail: mail,
//         providerId: userRef,
//         managedBy: contractorRef,
//         contractorId: callerUid,

//         address: {
//           fullAddress: fullAddress || "",
//         },

//         firstName: fName,
//         lastName: lName,
//         languages: langs,

//         // ✅ Mirror categories properly
//         categories: finalCategories,
//         categoriesNormalized: finalCategoriesNormalized,

//         ...geoFields,
//         updatedAt: FieldValue.serverTimestamp(),
//       },
//       { merge: true },
//     );

//     // -----------------------------
//     // 9) Send credentials email
//     // -----------------------------
//     const subject = "Your FixIt provider account";
//     const text =
//       `Hi ${fName || ""},\n\n` +
//       "A FixIt contractor has registered you as a service provider.\n\n" +
//       "You can now log in with:\n\n" +
//       `Email: ${mail}\n` +
//       `Password: ${pw}\n\n` +
//       "For security, please log in and change your password after first sign in.\n\n" +
//       "– FixIt Team";

//     await sendEmail(mail, subject, text);

//     return res.status(200).json({
//       ok: true,
//       providerUid,
//       geo,
//       categories: finalCategories,
//       categoriesNormalized: finalCategoriesNormalized,
//       version: "svcProviders-v4-categories-mirror",
//     });
//   } catch (err: any) {
//     console.error("create-provider-account error:", err);

//     const code = err.code || null;
//     const message = err.message || null;

//     return res.status(500).json({
//       error: "Failed to create provider account.",
//       code,
//       message,
//     });
//   }
// }

// pages/api/create-provider-account.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { admin } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/mailer";

function normalizeAddress(input: string): string {
  const raw = String(input || "").trim();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Remove consecutive duplicates (e.g. "Sri Lanka, Sri Lanka")
  const deduped: string[] = [];
  for (const p of parts) {
    if (
      deduped.length === 0 ||
      deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()
    ) {
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
  source: "nominatim" | "pin";
  query: string;
  displayName?: string | null;
  status: "ok" | "no_results" | "pin";
  updatedAt: admin.firestore.FieldValue;
};

function sanitizeStringArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length > 0);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const v of cleaned) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }
  return deduped;
}

function parsePinnedLocation(raw: any): Geo | null {
  if (!raw || typeof raw !== "object") return null;

  const lat = Number((raw as any).lat);
  const lng = Number((raw as any).lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;

  return { lat, lng };
}

async function geocodeAddress(
  address: string,
): Promise<{ geo: Geo; meta: { query: string; displayName?: string | null } } | null> {
  const query = String(address || "").trim();
  if (query.length < 6) return null;

  async function callNominatim(q: string) {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?q=${encodeURIComponent(q)}` +
      "&format=json&limit=3&addressdetails=1" +
      "&countrycodes=lk";

    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "FixIt-Academic-Project/1.0 (geocoding; contact: your-email@example.com)",
        Accept: "application/json",
        "Accept-Language": "en",
      },
    });

    if (!resp.ok) {
      console.error(`Nominatim HTTP ${resp.status}`);
      return [] as Array<{ lat: string; lon: string; display_name?: string }>;
    }

    const data = (await resp.json()) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
    }>;

    return Array.isArray(data) ? data : [];
  }

  try {
    let data = await callNominatim(query);

    // If no results, try removing house number from the beginning as a fallback
    if (!data.length) {
      const fallback = query
        .replace(/^\s*(no\.?\s*)?\d+[a-zA-Z0-9\/-]*\s*,\s*/i, "")
        .trim();

      if (fallback && fallback !== query) {
        data = await callNominatim(fallback);
      }
    }

    if (!data.length) return null;

    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      geo: { lat, lng },
      meta: {
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
    // -----------------------------
    // 1) Verify contractor identity
    // -----------------------------
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

    // -----------------------------
    // 2) Read request body
    // -----------------------------
    const {
      email = "",
      password = "",
      firstName = "",
      lastName = "",
      providerDocId = "",
      address = "",
      languages = [],
      skills = [],
      categories = [],
      categoriesNormalized = [],
      location = null, // {lat,lng} from pinned map
    } = req.body || {};

    const mail = String(email).trim().toLowerCase();
    const pw = String(password).trim();
    const fName = String(firstName).trim();
    const lName = String(lastName).trim();
    const providerId = String(providerDocId).trim();
    const fullAddress = normalizeAddress(address).trim();

    const langs = Array.isArray(languages) ? languages : [];
    const sks = Array.isArray(skills) ? skills : [];

    if (!mail || !mail.includes("@")) {
      return res.status(400).json({ error: "Invalid email." });
    }
    if (!pw || pw.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (!providerId) {
      return res.status(400).json({
        error: "Missing providerDocId (contractor providers doc id).",
      });
    }

    // ---------------------------------------------------------
    // 3) Read contractor provider subdoc for categories (source of truth)
    // ---------------------------------------------------------
    const contractorProviderRef = admin
      .firestore()
      .collection("contractors")
      .doc(callerUid)
      .collection("providers")
      .doc(providerId);

    const contractorProviderSnap = await contractorProviderRef.get();
    const contractorProviderData = contractorProviderSnap.exists
      ? (contractorProviderSnap.data() as Record<string, any>)
      : {};

    const finalCategories =
      sanitizeStringArray(contractorProviderData?.categories).length > 0
        ? sanitizeStringArray(contractorProviderData?.categories)
        : sanitizeStringArray(categories);

    const finalCategoriesNormalized =
      sanitizeStringArray(contractorProviderData?.categoriesNormalized).length > 0
        ? sanitizeStringArray(contractorProviderData?.categoriesNormalized)
        : sanitizeStringArray(categoriesNormalized);

    // -----------------------------
    // 4) Create Auth user
    // -----------------------------
    const userRecord = await admin.auth().createUser({
      email: mail,
      password: pw,
      displayName: `${fName} ${lName}`.trim() || undefined,
    });

    const providerUid = userRecord.uid;

    const contractorRef = admin.firestore().doc(`contractors/${callerUid}`);

    // -----------------------------
    // 5) ✅ Create/merge users/{providerUid}  (THIS is what makes rules work)
    // -----------------------------
    await admin.firestore().collection("users").doc(providerUid).set(
      {
        role: "provider",
        firstName: fName,
        lastName: lName,
        email: mail,
        contractorId: callerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // -----------------------------
    // 6) Determine GeoPoint (pin > nominatim > none)
    // -----------------------------
    const pinned = parsePinnedLocation(location);

    let geo: Geo | null = null;
    const geoFields: Record<string, any> = {};

    if (pinned) {
      geo = pinned;
      geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
      geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
      geoFields.geocode = {
        source: "pin",
        query: fullAddress || "",
        displayName: null,
        status: "pin",
        updatedAt: FieldValue.serverTimestamp(),
      } satisfies GeocodeMeta;
    } else {
      geoFields.geocode = {
        source: "nominatim",
        query: fullAddress || "",
        displayName: null,
        status: "no_results",
        updatedAt: FieldValue.serverTimestamp(),
      } satisfies GeocodeMeta;

      const geocoded = await geocodeAddress(fullAddress);
      if (geocoded) {
        geo = geocoded.geo;
        geoFields.location = new admin.firestore.GeoPoint(geo.lat, geo.lng);
        geoFields.locationUpdatedAt = FieldValue.serverTimestamp();
        geoFields.geocode = {
          source: "nominatim",
          query: geocoded.meta.query,
          displayName: geocoded.meta.displayName ?? null,
          status: "ok",
          updatedAt: FieldValue.serverTimestamp(),
        } satisfies GeocodeMeta;
      }
    }

    // -----------------------------
    // 7) Update contractor subdoc (ensure providerUid + geo + categories are present)
    // -----------------------------
    await contractorProviderRef.set(
      {
        providerUid,
        email: mail,
        firstName: fName,
        lastName: lName,
        address: fullAddress || "",
        languages: langs,
        skills: sks,
        managedBy: contractorRef,
        contractorId: callerUid,
        updatedAt: FieldValue.serverTimestamp(),

        categories: finalCategories,
        categoriesNormalized: finalCategoriesNormalized,

        ...geoFields,
      },
      { merge: true },
    );

    // -----------------------------
    // 8) Mirror into serviceProviders/{providerUid} (Matching reads this)
    // -----------------------------
    await admin.firestore().collection("serviceProviders").doc(providerUid).set(
      {
        providerUid,
        providerEmail: mail,
        managedBy: contractorRef,
        contractorId: callerUid,

        address: {
          fullAddress: fullAddress || "",
        },

        firstName: fName,
        lastName: lName,
        languages: langs,

        categories: finalCategories,
        categoriesNormalized: finalCategoriesNormalized,

        ...geoFields,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // -----------------------------
    // 9) Send credentials email
    // -----------------------------
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

    return res.status(200).json({
      ok: true,
      providerUid,
      geo,
      categories: finalCategories,
      categoriesNormalized: finalCategoriesNormalized,
      version: "create-provider-account-v5-users-role-provider",
    });
  } catch (err: any) {
    console.error("create-provider-account error:", err);

    return res.status(500).json({
      error: "Failed to create provider account.",
      code: err?.code || null,
      message: err?.message || null,
    });
  }
}
