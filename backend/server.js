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
const Stripe = require("stripe");

const PORT = process.env.PORT || 3000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

console.log("Stripe keys loaded:", !!STRIPE_PUBLISHABLE_KEY, !!STRIPE_SECRET_KEY);

const stripe = new Stripe(STRIPE_SECRET_KEY);
fal.config({ credentials: process.env.FAL_KEY });

// ---------- Firebase Admin ----------
let db = null;
try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    if (firebaseConfig && firebaseConfig.project_id) {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(firebaseConfig)
            });
        }
        db = admin.firestore();
        console.log("✅ Firebase Admin connected to Firestore");
    } else {
        console.warn("⚠️ Invalid FIREBASE_CONFIG – token verification will fail");
    }
} catch (err) {
    console.warn("⚠️ FIREBASE_CONFIG parse error – token verification will fail", err.message);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Auth middleware ----------
async function ensureAuthenticated(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "No token provided" });
    }
    const idToken = authHeader.split(" ")[1];
    if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase not initialized" });
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Token verification failed:", error.message);
        return res.status(401).json({ error: "Invalid token" });
    }
}

// ========== STRIPE ROUTES ==========
app.get("/api/stripe-key", (req, res) => {
    res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.post("/api/create-payment-intent", ensureAuthenticated, async (req, res) => {
    try {
        const { amount, credits, planName } = req.body;
        if (!amount || amount <= 0) throw new Error("Invalid amount");
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: "usd",
            payment_method_types: ["card"],
            metadata: { credits: String(credits), planName }
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error("Stripe error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ========== PAYMENT SUCCESS – UPDATE FIRESTORE (FIXED) ==========
app.post("/api/payment-success", ensureAuthenticated, async (req, res) => {
    console.log("🔥 Payment success endpoint hit");
    console.log("Request body:", req.body);

    try {
        const { userId, credits, plan } = req.body;
        if (!userId || !credits || isNaN(credits)) {
            return res.status(400).json({ error: "Missing userId or invalid credits" });
        }

        const userRef = db.collection("users").doc(userId);
        const updateData = {
            credits: admin.firestore.FieldValue.increment(parseInt(credits))
        };

        if (plan) {
            let days = 0;
            let planName = "";
            switch (plan) {
                case "weekly": days = 7; planName = "weekly"; break;
                case "15days": days = 15; planName = "15days"; break;
                case "monthly": days = 30; planName = "monthly"; break;
                default: break;
            }
            if (days > 0) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + days);
                updateData.subscriptionPlan = planName;
                updateData.subscriptionExpiry = expiresAt;
            }
        }
        updateData.lastUpdated = admin.firestore.FieldValue.serverTimestamp();

        await userRef.set(updateData, { merge: true });

        // Fetch updated credits to return
        const updatedDoc = await userRef.get();
        const newCredits = updatedDoc.data().credits;

        console.log(`✅ Updated user ${userId}: +${credits} credits, new total: ${newCredits}`);
        res.json({ success: true, newCredits: newCredits });
    } catch (error) {
        console.error("Payment success update error:", error);
        res.status(500).json({ error: "Failed to update user credits", details: error.message });
    }
});

// ========== DAILY REWARD – FIXED (persists in Firestore) ==========
app.post("/api/daily-reward", ensureAuthenticated, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "Missing userId" });
        }

        const userRef = db.collection("users").doc(userId);
        const userDoc = await userRef.get();

        const now = Date.now();
        const lastClaim = userDoc.exists ? userDoc.data().lastDailyReward : null;
        const oneDay = 24 * 60 * 60 * 1000;

        if (lastClaim && (now - lastClaim) < oneDay) {
            const hoursLeft = Math.ceil((oneDay - (now - lastClaim)) / (60 * 60 * 1000));
            return res.status(400).json({
                error: `Already claimed today! Next reward in ${hoursLeft} hours.`,
                alreadyClaimed: true
            });
        }

        // Increment credits AND store last claim time
        await userRef.set({
            credits: admin.firestore.FieldValue.increment(10),
            lastDailyReward: now
        }, { merge: true });

        const updatedDoc = await userRef.get();
        const newCredits = updatedDoc.data().credits;

        console.log(`✅ Daily reward claimed for ${userId}: +10 credits, total: ${newCredits}`);
        res.json({
            success: true,
            message: "+10 credits added!",
            newCredits: newCredits
        });
    } catch (error) {
        console.error("Daily reward error:", error);
        res.status(500).json({ error: "Failed to claim daily reward" });
    }
});

// ========== Helper: hairstyle preservation ==========
function shouldPreserveHairstyle(promptText) {
    const lower = promptText.toLowerCase();
    const changeKeywords = ["change hair", "different hair", "new hair", "different hairstyle", "new hairstyle", "change hairstyle", "alter hair", "modify hair", "different haircut", "new haircut"];
    return !changeKeywords.some(kw => lower.includes(kw));
}

// ========== 1. Generate image ==========
app.post("/api/generate", ensureAuthenticated, async (req, res) => {
    try {
        const { prompt, style } = req.body;
        if (!prompt) return res.status(400).json({ error: "Prompt required" });
        const styleMap = {
            realistic: "ultra realistic DSLR photo, cinematic lighting, realistic skin texture, 8k",
            cinematic: "cinematic movie scene, dramatic lighting, ultra realistic",
            cyberpunk: "cyberpunk neon city, realistic, cinematic",
            fantasy: "fantasy realistic art",
            portrait: "professional portrait photography"
        };
        const finalPrompt = `${prompt}, ${styleMap[style] || styleMap.realistic}, masterpiece, ultra detailed, sharp focus`;
        const result = await fal.subscribe("fal-ai/flux/dev", {
            input: { prompt: finalPrompt, image_size: "square_hd", num_images: 1, enable_safety_checker: false }
        });
        const imageUrl = result?.data?.images?.[0]?.url || result?.images?.[0]?.url || result?.data?.image?.url || result?.image?.url;
        if (!imageUrl) return res.status(500).json({ error: "No image URL" });
        res.json({ success: true, imageUrl });
    } catch (err) {
        console.error("Generate error:", err.message);
        res.status(500).json({ error: "Generation failed" });
    }
});

// ========== 2. Face‑preserving edit ==========
app.post("/api/edit", ensureAuthenticated, upload.single("image"), async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!req.file || !prompt) return res.status(400).json({ error: "Image and prompt required" });
        const preserveHair = shouldPreserveHairstyle(prompt);
        const hairInstruction = preserveHair ? "preserve exact hairstyle" : "change hairstyle according to the description";
        const imageBuffer = await sharp(req.file.buffer).resize(1024, 1024, { fit: "cover" }).jpeg({ quality: 100 }).toBuffer();
        const fileBlob = new Blob([imageBuffer], { type: "image/jpeg" });
        const uploadedUrl = await fal.storage.upload(fileBlob);
        const result = await fal.subscribe("fal-ai/flux-pulid", {
            input: {
                reference_image_url: uploadedUrl,
                prompt: `${prompt}, same exact person, preserve exact face, preserve eyes, preserve identity, ${hairInstruction}, ultra realistic, cinematic lighting, realistic human, DSLR photography, realistic skin texture, detailed face, masterpiece, 8k quality`
            }
        });
        const imageUrl = result?.data?.image?.url || result?.data?.images?.[0]?.url || result?.image?.url || result?.images?.[0]?.url;
        if (!imageUrl) return res.status(500).json({ error: "No edited image URL" });
        res.json({ success: true, imageUrl });
    } catch (err) {
        console.error("Edit error:", err.message);
        res.status(500).json({ error: "Editing failed" });
    }
});

// ========== Serve frontend ==========
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
