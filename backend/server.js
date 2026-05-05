<script type="module">
    import { initializeApp } from "firebase/app";
    import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail } from "firebase/auth";
    import { getFirestore, doc, getDoc, setDoc, updateDoc, increment, serverTimestamp } from "firebase/firestore";

    const API_BASE = "/api";
    const firebaseConfig = { /* your config */ };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    let currentUser = null;
    let credits = 0;
    let gallery = [];
    let lastDaily = null;
    let totalGenerations = 0;
    let currentGenImage = null;
    let currentEditImg = null;
    let activeStyle = "realistic";
    let subscription = { plan: "free", expiry: null };
    let stripe = null, elements = null, card = null, clientSecret = null, pendingPlan = null;

    // Helper functions (showToast, downloadUrl, etc.) remain the same as before

    // 🔥 NEW: Get fresh token every time
    async function getValidToken() {
        if (!currentUser) throw new Error("No user");
        return await currentUser.getIdToken(true);
    }

    async function fetchWithAuth(url, options = {}) {
        const token = await getValidToken();
        const headers = { ...options.headers, "Authorization": `Bearer ${token}` };
        const res = await fetch(`${API_BASE}${url}`, { ...options, headers });
        if (res.status === 401) {
            const newToken = await getValidToken();
            const retryHeaders = { ...options.headers, "Authorization": `Bearer ${newToken}` };
            const retryRes = await fetch(`${API_BASE}${url}`, { ...options, headers: retryHeaders });
            if (retryRes.status === 401) {
                showToast("Session expired. Please login again.", true);
                logout();
                throw new Error("Unauthorized");
            }
            return retryRes;
        }
        return res;
    }

    // All other functions (syncCreditsFromFirestore, claimDaily, generate, edit, etc.) 
    // should use fetchWithAuth instead of direct fetch with old idToken.
    // They already do because you defined fetchWithAuth globally.

    // Example: update claimDaily to use fetchWithAuth
    async function claimDaily() {
        if (!currentUser) { showToast("Please sign in first", true); return; }
        try {
            const res = await fetchWithAuth("/daily-reward", { method: "POST" });
            const data = await res.json();
            if (res.ok) {
                credits = data.credits;
                lastDaily = new Date().toDateString();
                updateUI();
                showToast(data.message);
                await syncCreditsFromFirestore();
            } else {
                showToast(data.error, true);
            }
        } catch (err) {
            showToast(err.message, true);
        }
    }

    // Similarly update generate(), editImage() to use fetchWithAuth – they already do.

    // The rest of your code (login, signup, modals, event listeners) stays unchanged.

    // Initialize Stripe and other listeners...
    initStripe();
</script>
