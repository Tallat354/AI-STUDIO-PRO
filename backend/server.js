require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const fal = require("@fal-ai/serverless-client");
const admin = require("firebase-admin");
const path = require("path");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Fal.ai
if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });

// ---------------------------
// Firebase Admin Setup
// ---------------------------
let db, auth;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  auth = admin.auth();
  console.log("✅ Firebase Admin initialized. Project:", serviceAccount.project_id);
} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

// Helper: Ensure user document exists with default credits
async function ensureUser(uid) {
  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();
  if (!doc.exists) {
    await userRef.set({
      credits: 20,
      lastDailyClaim: null,
      subscription: { plan: "free", expiry: null },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ New user ${uid} created with 20 credits`);
    return { credits: 20, subscription: { plan: "free", expiry: null } };
  }
  return doc.data();
}

// Authentication middleware
async function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    req.userData = await ensureUser(decoded.uid);
    next();
  } catch (err) {
    console.error("Token verification error:", err.code, err.message);
    return res.status(401).json({ error: "Invalid token", message: err.message });
  }
}

// ---------------------------
// API Routes
// ---------------------------
app.get("/api/user", authMiddleware, (req, res) => {
  res.json({
    credits: req.userData.credits,
    subscription: req.userData.subscription,
    lastDailyClaim: req.userData.lastDailyClaim,
  });
});

app.post("/api/daily-reward", authMiddleware, async (req, res) => {
  const uid = req.user.uid;
  const userRef = db.collection("users").doc(uid);
  const data = req.userData;
  const lastClaim = data.lastDailyClaim?.toDate?.()?.getTime() || null;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (lastClaim && now - lastClaim < dayMs) {
    const hoursLeft = Math.ceil((dayMs - (now - lastClaim)) / (60 * 60 * 1000));
    return res.status(400).json({ error: `Already claimed. Try in ${hoursLeft} hours` });
  }
  await userRef.update({
    credits: admin.firestore.FieldValue.increment(10),
    lastDailyClaim: admin.firestore.FieldValue.serverTimestamp(),
  });
  const updated = await userRef.get();
  res.json({ success: true, credits: updated.data().credits, message: "+10 credits" });
});

app.get("/api/stripe-key", (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.post("/api/create-payment-intent", authMiddleware, async (req, res) => {
  const { amount, credits, planName } = req.body;
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: "usd",
    payment_method_types: ["card"],
    metadata: { credits, planName, userId: req.user.uid },
  });
  res.json({ clientSecret: intent.client_secret });
});

app.post("/api/confirm-payment", authMiddleware, async (req, res) => {
  const { credits, planName } = req.body;
  const uid = req.user.uid;
  const userRef = db.collection("users").doc(uid);
  let expiry = new Date();
  if (planName === "weekly") expiry.setDate(expiry.getDate() + 7);
  else if (planName === "15days") expiry.setDate(expiry.getDate() + 15);
  else if (planName === "monthly") expiry.setMonth(expiry.getMonth() + 1);
  else expiry.setDate(expiry.getDate() + 30);
  await userRef.update({
    credits: admin.firestore.FieldValue.increment(credits),
    subscription: { plan: planName, expiry: expiry.toISOString() },
  });
  const updated = await userRef.get();
  res.json({ success: true, credits: updated.data().credits, subscription: updated.data().subscription });
});

// AI Generate (1 credit)
app.post("/api/generate", authMiddleware, async (req, res) => {
  const { prompt, style } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });
  if (req.userData.credits < 1) return res.status(400).json({ error: "Not enough credits" });
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
  await db.collection("users").doc(req.user.uid).update({ credits: admin.firestore.FieldValue.increment(-1) });
  res.json({ success: true, imageUrl });
});

// Face Edit (2 credits)
const upload = multer({ storage: multer.memoryStorage() });
function shouldPreserveHairstyle(p) {
  const kw = ["change hair", "different hair", "new hair", "different hairstyle"];
  return !kw.some(k => p.toLowerCase().includes(k));
}
app.post("/api/edit", authMiddleware, upload.single("image"), async (req, res) => {
  const { prompt } = req.body;
  if (!req.file || !prompt) return res.status(400).json({ error: "Image and prompt required" });
  if (req.userData.credits < 2) return res.status(400).json({ error: "Need 2 credits" });
  const preserve = shouldPreserveHairstyle(prompt);
  const hairInstr = preserve ? "preserve exact hairstyle" : "change hairstyle as described";
  const buffer = await sharp(req.file.buffer).resize(1024, 1024, { fit: "cover" }).jpeg().toBuffer();
  const blob = new Blob([buffer], { type: "image/jpeg" });
  const uploadedUrl = await fal.storage.upload(blob);
  const result = await fal.subscribe("fal-ai/flux-pulid", {
    input: {
      reference_image_url: uploadedUrl,
      prompt: `${prompt}, same exact person, preserve face, ${hairInstr}, ultra realistic, 8k`,
    },
  });
  const imageUrl = result?.data?.image?.url || result?.data?.images?.[0]?.url;
  if (!imageUrl) return res.status(500).json({ error: "No edited image" });
  await db.collection("users").doc(req.user.uid).update({ credits: admin.firestore.FieldValue.increment(-2) });
  res.json({ success: true, imageUrl });
});

// Serve frontend
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
