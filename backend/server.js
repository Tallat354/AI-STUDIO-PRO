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

// ========== STRIPE ==========
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
if (!STRIPE_SECRET_KEY) console.error("❌ STRIPE_SECRET_KEY missing");
const stripe = new Stripe(STRIPE_SECRET_KEY);

// ========== FAL.AI ==========
if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
} else {
  console.warn("⚠️ FAL_KEY missing – generation will fail");
}

// ========== FIREBASE ADMIN (FIXED for v12+) ==========
let db = null;
let adminAuth = null;

const firebaseConfigRaw = process.env.FIREBASE_CONFIG;
if (!firebaseConfigRaw) {
  console.error("❌ FIREBASE_CONFIG environment variable is missing.");
} else {
  try {
    const firebaseConfig = JSON.parse(firebaseConfigRaw);
    if (firebaseConfig && firebaseConfig.project_id) {
      // Initialize Firebase Admin (v12+)
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig),
      });
      // Connect to Firestore with database ID 'mydata'
      db = admin.firestore();
      // For Firestore database with custom ID, use this syntax:
      // db = admin.firestore().databaseId('mydata'); 
      // But simpler: just use default and then apply settings
      // Actually in v12+, you can do:
      // const db = admin.firestore({ databaseId: 'mydata' });
      // But to avoid any issue, we use settings method:
      db.settings({ databaseId: 'mydata' });
      
      adminAuth = admin.auth();
      console.log("✅ Firebase Admin connected to project:", firebaseConfig.project_id);
      
      // Test Firestore access
      db.collection("users").limit(1).get().catch(err => {
        console.error("❌ Firestore access error:", err.message);
      });
    } else {
      console.error("❌ Firebase config missing 'project_id'");
    }
  } catch (err) {
    console.error("❌ Firebase config parse error:", err.message);
  }
}

// ========== AUTH MIDDLEWARE ==========
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
    console.error("Token verification failed:", err.code, err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function ensureUserDocument(userId) {
  if (!db) throw new Error("Firestore not available");
  const userRef = db.collection("users").doc(userId);
  const docSnap = await userRef.get();
  if (!docSnap.exists) {
    await userRef.set({
      credits: 20,
      lastDailyClaim: null,
      totalGenerations: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { credits: 20, lastDailyClaim: null, totalGenerations: 0 };
  }
  return docSnap.data();
}

// ========== STRIPE ENDPOINTS ==========
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
      metadata: { credits: String(credits), planName, userId: req.user.uid },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Payment intent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========== DAILY REWARD ==========
app.post("/api/daily-reward", ensureAuthenticated, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firestore not available" });
  try {
    const userId = req.user.uid;
    const userRef = db.collection("users").doc(userId);
    await ensureUserDocument(userId);

    const docSnap = await userRef.get();
    const userData = docSnap.data();
    const lastClaim = userData.lastDailyClaim;
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    let lastClaimMs = null;
    if (lastClaim) {
      lastClaimMs = lastClaim.toDate ? lastClaim.toDate().getTime() : lastClaim;
    }

    if (lastClaimMs && (now - lastClaimMs) < twentyFourHours) {
      const hoursLeft = Math.ceil((twentyFourHours - (now - lastClaimMs)) / (60 * 60 * 1000));
      return res.status(400).json({ error: `Already claimed. Try again in ${hoursLeft} hours` });
    }

    await userRef.update({
      credits: admin.firestore.FieldValue.increment(10),
      lastDailyClaim: admin.firestore.FieldValue.serverTimestamp()
    });

    const updated = await userRef.get();
    res.json({ success: true, credits: updated.data().credits, message: "+10 credits claimed!" });
  } catch (err) {
    console.error("Daily reward error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========== AI GENERATION ==========
app.post("/api/generate", ensureAuthenticated, async (req, res) => {
  try {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });
    if (!db) return res.status(503).json({ error: "Firestore not available" });

    const userId = req.user.uid;
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists || userSnap.data().credits < 1) {
      return res.status(402).json({ error: "Insufficient credits" });
    }

    const styleMap = {
      realistic: "ultra realistic DSLR photo, cinematic lighting, realistic skin texture, 8k",
      cinematic: "cinematic movie scene, dramatic lighting, ultra realistic",
      cyberpunk: "cyberpunk neon city, realistic, cinematic",
      fantasy: "fantasy realistic art",
      portrait: "professional portrait photography",
    };
    const finalPrompt = `${prompt}, ${styleMap[style] || styleMap.realistic}, masterpiece, ultra detailed, sharp focus`;

    const result = await fal.subscribe("fal-ai/flux/dev", {
      input: { prompt: finalPrompt, image_size: "square_hd", num_images: 1, enable_safety_checker: false },
    });

    const imageUrl = result?.data?.images?.[0]?.url || result?.images?.[0]?.url || result?.data?.image?.url || result?.image?.url;
    if (!imageUrl) return res.status(500).json({ error: "No image URL" });

    await userRef.update({
      credits: admin.firestore.FieldValue.increment(-1),
      totalGenerations: admin.firestore.FieldValue.increment(1)
    });
    const updated = await userRef.get();

    res.json({ success: true, imageUrl, credits: updated.data().credits, totalGenerations: updated.data().totalGenerations });
  } catch (err) {
    console.error("Generation error:", err);
    res.status(500).json({ error: "Generation failed: " + err.message });
  }
});

function shouldPreserveHairstyle(promptText) {
  const lower = promptText.toLowerCase();
  const changeKeywords = ["change hair", "different hair", "new hair", "different hairstyle", "new hairstyle", "change hairstyle", "alter hair", "modify hair", "different haircut", "new haircut"];
  return !changeKeywords.some(kw => lower.includes(kw));
}

const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/edit", ensureAuthenticated, upload.single("image"), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!req.file || !prompt) return res.status(400).json({ error: "Image and prompt required" });
    if (!db) return res.status(503).json({ error: "Firestore not available" });

    const userId = req.user.uid;
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists || userSnap.data().credits < 2) {
      return res.status(402).json({ error: "Need 2 credits for edit" });
    }

    const preserveHair = shouldPreserveHairstyle(prompt);
    const hairInstruction = preserveHair ? "preserve exact hairstyle" : "change hairstyle according to the description";

    const imageBuffer = await sharp(req.file.buffer).resize(1024, 1024, { fit: "cover" }).jpeg({ quality: 100 }).toBuffer();
    const fileBlob = new Blob([imageBuffer], { type: "image/jpeg" });
    const uploadedUrl = await fal.storage.upload(fileBlob);

    const result = await fal.subscribe("fal-ai/flux-pulid", {
      input: {
        reference_image_url: uploadedUrl,
        prompt: `${prompt}, same exact person, preserve exact face, preserve eyes, preserve identity, ${hairInstruction}, ultra realistic, cinematic lighting, realistic human, DSLR photography, realistic skin texture, detailed face, masterpiece, 8k quality`,
      },
    });

    const imageUrl = result?.data?.image?.url || result?.data?.images?.[0]?.url || result?.image?.url || result?.images?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: "No edited image" });

    await userRef.update({ credits: admin.firestore.FieldValue.increment(-2) });
    const updated = await userRef.get();

    res.json({ success: true, imageUrl, credits: updated.data().credits });
  } catch (err) {
    console.error("Edit error:", err);
    res.status(500).json({ error: "Editing failed: " + err.message });
  }
});

// ========== GALLERY ENDPOINTS ==========
app.get("/api/gallery", ensureAuthenticated, async (req, res) => {
  try {
    if (!db) throw new Error("Firestore not available");
    const userId = req.user.uid;
    const galleryRef = db.collection("users").doc(userId).collection("gallery");
    const snapshot = await galleryRef.orderBy("createdAt", "desc").get();
    const images = [];
    snapshot.forEach(doc => images.push({ id: doc.id, url: doc.data().url }));
    res.json({ images });
  } catch (err) {
    console.error("Gallery fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/gallery/add", ensureAuthenticated, async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "No image URL" });
    if (!db) throw new Error("Firestore not available");
    const userId = req.user.uid;
    const galleryRef = db.collection("users").doc(userId).collection("gallery");
    await galleryRef.add({ url: imageUrl, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (err) {
    console.error("Add to gallery error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/user-data", ensureAuthenticated, async (req, res) => {
  try {
    if (!db) throw new Error("Firestore not available");
    const userId = req.user.uid;
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      await ensureUserDocument(userId);
      const freshSnap = await userRef.get();
      return res.json(freshSnap.data());
    }
    res.json(userSnap.data());
  } catch (err) {
    console.error("User data error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========== SERVE FRONTEND ==========
const frontendPath = path.join(__dirname, "../frontend");
if (!fs.existsSync(frontendPath)) {
  console.error(`❌ Frontend folder not found at ${frontendPath}`);
  console.error("   Expected: backend/server.js and frontend/index.html");
  process.exit(1);
}
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   Frontend: ${frontendPath}`);
  if (!db) console.error("⚠️ Firestore not connected – daily reward & gallery will fail.");
});
