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
// Firebase Admin – collection "users"
// -----------------------------
let db = null;
let adminAuth = null;
try {
  const raw = process.env.FIREBASE_CONFIG;
  if (raw) {
    const config = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(config) });
    db = admin.firestore();
    adminAuth = admin.auth();
    console.log("✅ Firebase Admin connected. Project:", config.project_id);
  }
} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

// 🔥 Create user document ONLY if not exists (never overwrite)
async function ensureUserDocument(uid) {
  if (!db) throw new Error("Firestore not available");
  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();
  if (!doc.exists) {
    // First time – set initial credits, no subscription
    await userRef.set({
      credits: 20,
      lastDailyClaim: null,
      subscription: { plan: "free", expiry: null },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Created new user ${uid} with 20 credits, free plan`);
    return { credits: 20, subscription: { plan: "free", expiry: null } };
  }
  return doc.data();
}

// 🔥 Middleware – ensures user exists and attaches user data to req
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
    req.userData = await ensureUserDocument(decoded.uid);
    next();
  } catch (err) {
    console.error("❌ Token verify failed:", err.code, err.message);
    res.status(401).json({ error: "Invalid token", details: err.message });
  }
}

// -----------------------------
// 🔐 GET /api/user – return current user's credits & subscription
// Frontend login ke baad yeh call karega
// -----------------------------
app.get("/api/user", ensureAuthenticated, (req, res) => {
  res.json({
    uid: req.user.uid,
    credits: req.userData.credits,
    subscription: req.userData.subscription || { plan: "free", expiry: null },
    lastDailyClaim: req.userData.lastDailyClaim || null,
  });
});

// -----------------------------
// 💰 Daily Reward (24h cooldown) – updates Firestore
// -----------------------------
app.post("/api/daily-reward", ensureAuthenticated, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firestore not available" });
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);
    const userData = req.userData; // from middleware

    let last = userData.lastDailyClaim?.toDate?.()?.getTime() || null;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    if (last && now - last < day) {
      const hours = Math.ceil((day - (now - last)) / (60 * 60 * 1000));
      return res.status(400).json({ error: `Already claimed. Try in ${hours} hours` });
    }

    // Update credits (+10) and lastDailyClaim
    await userRef.update({
      credits: admin.firestore.FieldValue.increment(10),
      lastDailyClaim: admin.firestore.FieldValue.serverTimestamp(),
    });
    const updated = await userRef.get();
    res.json({
      success: true,
      credits: updated.data().credits,
      message: "+10 credits claimed!",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// 💳 Stripe Payment – add purchased credits and update subscription
// -----------------------------
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// After successful payment, frontend calls this endpoint to add credits & subscription
app.post("/api/confirm-payment", ensureAuthenticated, async (req, res) => {
  const { credits, planName, paymentIntentId } = req.body;
  if (!credits || !planName) {
    return res.status(400).json({ error: "Missing data" });
  }
  try {
    const uid = req.user.uid;
    const userRef = db.collection("users").doc(uid);
    const expiry = new Date();
    if (planName === "weekly") expiry.setDate(expiry.getDate() + 7);
    else if (planName === "15days") expiry.setDate(expiry.getDate() + 15);
    else if (planName === "monthly") expiry.setMonth(expiry.getMonth() + 1);
    else expiry.setDate(expiry.getDate() + 30); // default

    await userRef.update({
      credits: admin.firestore.FieldValue.increment(credits),
      subscription: { plan: planName, expiry: expiry.toISOString() },
    });
    const updated = await userRef.get();
    res.json({
      success: true,
      credits: updated.data().credits,
      subscription: updated.data().subscription,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// 🎨 AI Generate – deduct 1 credit
// -----------------------------
app.post("/api/generate", ensureAuthenticated, async (req, res) => {
  try {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });
    if (req.userData.credits < 1) {
      return res.status(400).json({ error: "Insufficient credits" });
    }
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
    // Deduct credit
    await db.collection("users").doc(req.user.uid).update({
      credits: admin.firestore.FieldValue.increment(-1),
    });
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Generation failed" });
  }
});

// -----------------------------
// ✏️ Face Edit – deduct 2 credits
// -----------------------------
function shouldPreserveHairstyle(p) {
  const kw = ["change hair", "different hair", "new hair", "different hairstyle"];
  return !kw.some(k => p.toLowerCase().includes(k));
}
const upload = multer({ storage: multer.memoryStorage() });
app.post("/api/edit", ensureAuthenticated, upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.body.prompt) return res.status(400).json({ error: "Image and prompt required" });
    if (req.userData.credits < 2) {
      return res.status(400).json({ error: "Need 2 credits" });
    }
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
    await db.collection("users").doc(req.user.uid).update({
      credits: admin.firestore.FieldValue.increment(-2),
    });
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Editing failed" });
  }
});

// -----------------------------
// 🌐 Serve frontend
// -----------------------------
const frontendPath = path.join(__dirname, "../frontend");
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  console.warn(`⚠️ Frontend folder missing at ${frontendPath}`);
}

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
