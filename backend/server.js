require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const FormData = require("form-data");
const axios = require("axios");
const fal = require("@fal-ai/serverless-client");
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const Stripe = require("stripe");

// -------------------------
// 1. CONFIGURATION (single PORT)
// -------------------------
const PORT = process.env.PORT || 3000;
const app = express();

// CORS – allow all origins (Render frontend/backend may be different)
app.use(cors({ origin: "*" }));
app.options("*", cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------------
// 2. STRIPE INIT
// -------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
if (!STRIPE_SECRET_KEY) console.error("❌ STRIPE_SECRET_KEY missing");
const stripe = new Stripe(STRIPE_SECRET_KEY);

// -------------------------
// 3. FAL.AI CONFIG
// -------------------------
if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
} else {
  console.warn("⚠️ FAL_KEY missing – generation endpoints will fail");
}

// -------------------------
// 4. FIREBASE ADMIN (graceful fallback)
// -------------------------
let db = null;
let adminAuth = null;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (firebaseConfig && firebaseConfig.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    db = admin.firestore();
    adminAuth = admin.auth();
    console.log("✅ Firebase Admin connected");
  } else {
    console.warn("⚠️ Firebase config incomplete – auth endpoints will fail");
  }
} catch (err) {
  console.warn("⚠️ Firebase config parse error:", err.message);
}

// -------------------------
// 5. AUTH MIDDLEWARE (safe if Firebase missing)
// -------------------------
async function ensureAuthenticated(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (!adminAuth) {
    return res.status(503).json({ error: "Firebase Auth not configured" });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const idToken = authHeader.split(" ")[1];
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -------------------------
// 6. STRIPE ENDPOINTS
// -------------------------
app.get("/api/stripe-key", (req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Stripe key not configured" });
  }
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.post("/api/create-payment-intent", ensureAuthenticated, async (req, res) => {
  try {
    const { amount, credits, planName } = req.body;
    if (!amount || !credits || !planName) {
      return res.status(400).json({ error: "Missing payment details" });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      payment_method_types: ["card"],
      metadata: {
        credits: String(credits),
        planName: planName,
        userId: req.user.uid,
      },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Payment intent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------
// 7. DAILY REWARD (requires Firestore)
// -------------------------
app.post("/api/daily-reward", ensureAuthenticated, async (req, res) => {
  try {
    if (!db) throw new Error("Firestore not available");
    const userId = req.user.uid;
    const today = new Date().toDateString();
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        credits: 20,
        lastDailyClaim: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const existing = await userRef.get();
    if (existing.data().lastDailyClaim === today) {
      return res.status(400).json({ error: "Already claimed today" });
    }

    await userRef.update({
      credits: admin.firestore.FieldValue.increment(10),
      lastDailyClaim: today,
    });

    const updated = await userRef.get();
    res.json({
      success: true,
      credits: updated.data().credits,
      message: "+10 credits",
    });
  } catch (err) {
    console.error("Daily reward error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------
// 8. AI GENERATION (fal.ai)
// -------------------------
app.post("/api/generate", ensureAuthenticated, async (req, res) => {
  try {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const styleMap = {
      realistic:
        "ultra realistic DSLR photo, cinematic lighting, realistic skin texture, 8k",
      cinematic: "cinematic movie scene, dramatic lighting, ultra realistic",
      cyberpunk: "cyberpunk neon city, realistic, cinematic",
      fantasy: "fantasy realistic art",
      portrait: "professional portrait photography",
    };
    const finalPrompt = `${prompt}, ${styleMap[style] || styleMap.realistic}, masterpiece, ultra detailed, sharp focus`;

    const result = await fal.subscribe("fal-ai/flux/dev", {
      input: {
        prompt: finalPrompt,
        image_size: "square_hd",
        num_images: 1,
        enable_safety_checker: false,
      },
    });
    const imageUrl =
      result?.data?.images?.[0]?.url ||
      result?.images?.[0]?.url ||
      result?.data?.image?.url ||
      result?.image?.url;

    if (!imageUrl) return res.status(500).json({ error: "No image URL" });
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error("Generation error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Helper for hairstyle preservation (face‑preserving edit)
function shouldPreserveHairstyle(promptText) {
  const lower = promptText.toLowerCase();
  const changeKeywords = [
    "change hair",
    "different hair",
    "new hair",
    "different hairstyle",
    "new hairstyle",
    "change hairstyle",
    "alter hair",
    "modify hair",
    "different haircut",
    "new haircut",
  ];
  return !changeKeywords.some((kw) => lower.includes(kw));
}

const upload = multer({ storage: multer.memoryStorage() });

app.post(
  "/api/edit",
  ensureAuthenticated,
  upload.single("image"),
  async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!req.file || !prompt) {
        return res.status(400).json({ error: "Image and prompt required" });
      }

      const preserveHair = shouldPreserveHairstyle(prompt);
      const hairInstruction = preserveHair
        ? "preserve exact hairstyle"
        : "change hairstyle according to the description";

      const imageBuffer = await sharp(req.file.buffer)
        .resize(1024, 1024, { fit: "cover" })
        .jpeg({ quality: 100 })
        .toBuffer();

      const fileBlob = new Blob([imageBuffer], { type: "image/jpeg" });
      const uploadedUrl = await fal.storage.upload(fileBlob);

      const result = await fal.subscribe("fal-ai/flux-pulid", {
        input: {
          reference_image_url: uploadedUrl,
          prompt: `${prompt}, same exact person, preserve exact face, preserve eyes, preserve identity, ${hairInstruction}, ultra realistic, cinematic lighting, realistic human, DSLR photography, realistic skin texture, detailed face, masterpiece, 8k quality`,
        },
      });

      const imageUrl =
        result?.data?.image?.url ||
        result?.data?.images?.[0]?.url ||
        result?.image?.url ||
        result?.images?.[0]?.url;

      if (!imageUrl) return res.status(500).json({ error: "No edited image" });
      res.json({ success: true, imageUrl });
    } catch (err) {
      console.error("Edit error:", err);
      res.status(500).json({ error: "Editing failed" });
    }
  }
);

// -------------------------
// 9. SERVE FRONTEND (from ../frontend)
// -------------------------
const frontendPath = path.join(__dirname, "../frontend");
if (!fs.existsSync(frontendPath)) {
  console.error(`❌ Frontend folder not found at ${frontendPath}`);
  console.error("   Make sure your backend and frontend are siblings:");
  console.error("   /backend/server.js");
  console.error("   /frontend/index.html");
} else {
  console.log(`✅ Serving frontend from ${frontendPath}`);
}
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// -------------------------
// 10. START SERVER
// -------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`   Static folder: ${frontendPath}`);
});
