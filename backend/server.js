require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const fal = require("@fal-ai/serverless-client");
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const Stripe = require("stripe");

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors({ origin: "*" }));
app.options("*", cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });

// -----------------------------
// Firebase Admin – "users" collection
// -----------------------------
let db = null;
let adminAuth = null;
try {
  const rawConfig = process.env.FIREBASE_CONFIG;
  if (!rawConfig) throw new Error("FIREBASE_CONFIG missing");
  const firebaseConfig = JSON.parse(rawConfig);
  if (!firebaseConfig.project_id) throw new Error("No project_id");
  admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
  db = admin.firestore();
  adminAuth = admin.auth();
  console.log("✅ Firebase Admin connected, project:", firebaseConfig.project_id);
} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

// Helper – auto‑create user with 20 credits
async function ensureUserDocument(uid) {
  if (!db) throw new Error("Firestore not available");
  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();
  if (!doc.exists) {
    await userRef.set({
      credits: 20,
      lastDailyClaim: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Created new user ${uid} with 20 credits`);
    return { credits: 20, lastDailyClaim: null };
  }
  return doc.data();
}

// Auth middleware
async function ensureAuthenticated(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (!adminAuth) return res.status(503).json({ error: "Auth not ready" });
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await adminAuth.verifyIdToken(token, true);
    req.user = decoded;
    await ensureUserDocument(decoded.uid);
    next();
  } catch (err) {
    console.error("❌ Token verify failed:", err.code, err.message);
    res.status(401).json({ error: "Invalid token", details: err.message });
  }
}

// Test endpoints
app.get("/api/firebase-test", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not available" });
  try {
    await db.collection("users").doc("test").set({ test: true }, { merge: true });
    res.json({ success: true, message: "Firebase OK" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/verify-token", ensureAuthenticated, (req, res) => {
  res.json({ success: true, uid: req.user.uid });
});

// Stripe
app.get("/api/stripe-key", (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});
app.post("/api/create-payment-intent", ensureAuthenticated, async (req, res) => {
  try {
    const { amount, credits, planName } = req.body;
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      payment_method_types: ["card"],
      metadata: { credits: String(credits), planName, userId: req.user.uid },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily reward
app.post("/api/daily-reward", ensureAuthenticated, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firestore not available" });
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);
    const data = await ensureUserDocument(uid);
    let last = data.lastDailyClaim?.toDate?.()?.getTime() || null;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    if (last && now - last < day) {
      const hours = Math.ceil((day - (now - last)) / (60 * 60 * 1000));
      return res.status(400).json({ error: `Try again in ${hours} hours` });
    }
    await userRef.update({
      credits: admin.firestore.FieldValue.increment(10),
      lastDailyClaim: admin.firestore.FieldValue.serverTimestamp(),
    });
    const updated = await userRef.get();
    res.json({ success: true, credits: updated.data().credits, message: "+10 credits" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate image
app.post("/api/generate", ensureAuthenticated, async (req, res) => {
  try {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });
    const styleMap = {
      realistic: "ultra realistic DSLR photo, 8k",
      cinematic: "cinematic movie scene, dramatic lighting",
      cyberpunk: "cyberpunk neon city, realistic",
      fantasy: "fantasy realistic art",
      portrait: "professional portrait photography",
    };
    const finalPrompt = `${prompt}, ${styleMap[style] || styleMap.realistic}, masterpiece, ultra detailed`;
    const result = await fal.subscribe("fal-ai/flux/dev", {
      input: { prompt: finalPrompt, image_size: "square_hd", num_images: 1, enable_safety_checker: false },
    });
    const imageUrl = result?.data?.images?.[0]?.url || result?.images?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: "No image URL" });
    if (db) await db.collection("users").doc(req.user.uid).update({ credits: admin.firestore.FieldValue.increment(-1) });
    res.json({ success: true, imageUrl });
  } catch (err) {
    res.status(500).json({ error: "Generation failed" });
  }
});

// Edit face
function shouldPreserveHairstyle(p) {
  const kw = ["change hair", "different hair", "new hair", "different hairstyle"];
  return !kw.some(k => p.toLowerCase().includes(k));
}
const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/edit", ensureAuthenticated, upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.body.prompt) return res.status(400).json({ error: "Image and prompt required" });
    const preserve = shouldPreserveHairstyle(req.body.prompt);
    const hairInstr = preserve ? "preserve exact hairstyle" : "change hairstyle as described";
    const buffer = await sharp(req.file.buffer).resize(1024, 1024, { fit: "cover" }).jpeg({ quality: 100 }).toBuffer();
    const blob = new Blob([buffer], { type: "image/jpeg" });
    const uploadedUrl = await fal.storage.upload(blob);
    const result = await fal.subscribe("fal-ai/flux-pulid", {
      input: {
        reference_image_url: uploadedUrl,
        prompt: `${req.body.prompt}, same exact person, preserve face, ${hairInstr}, ultra realistic, 8k`,
      },
    });
    const imageUrl = result?.data?.image?.url || result?.data?.images?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: "No edited image" });
    if (db) await db.collection("users").doc(req.user.uid).update({ credits: admin.firestore.FieldValue.increment(-2) });
    res.json({ success: true, imageUrl });
  } catch (err) {
    res.status(500).json({ error: "Editing failed" });
  }
});

// Serve frontend
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
