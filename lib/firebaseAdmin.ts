// lib/firebaseAdmin.ts
import * as admin from "firebase-admin";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return v;
}

if (!admin.apps.length) {
  // IMPORTANT:
  // firebase-admin expects service account keys in snake_case:
  // project_id, client_email, private_key
  const projectId = requiredEnv("FIREBASE_PROJECT_ID");
  const clientEmail = requiredEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = requiredEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    } as admin.ServiceAccount),
  });
}

export { admin };
