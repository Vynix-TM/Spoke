import { auth, db, googleProvider } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithRedirect,
  getRedirectResult,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const tabLogin = document.getElementById("tab-login");
const tabSignup = document.getElementById("tab-signup");
const panelLogin = document.getElementById("panel-login");
const panelSignup = document.getElementById("panel-signup");

function activate(tab) {
  const isLogin = tab === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabSignup.classList.toggle("active", !isLogin);
  panelLogin.classList.toggle("active", isLogin);
  panelSignup.classList.toggle("active", !isLogin);
}
tabLogin.addEventListener("click", () => activate("login"));
tabSignup.addEventListener("click", () => activate("signup"));

let redirecting = false;
let handlingGoogleRedirect = false;

// Handle the return from signInWithRedirect (Google). This must resolve
// BEFORE onAuthStateChanged is allowed to bounce the user to chat.html,
// otherwise new users skip profile creation.
handlingGoogleRedirect = true;
getRedirectResult(auth)
  .then(async (cred) => {
    if (cred && cred.user) {
      const existing = await getDoc(doc(db, "users", cred.user.uid));
      if (!existing.exists()) {
        await createUserProfile(cred.user, {
          displayName: cred.user.displayName || "New user",
          username: generateUsername(cred.user.email, cred.user.displayName),
          email: cred.user.email,
          photoURL: cred.user.photoURL || null,
        });
      }
      redirecting = true;
      window.location.href = "chat.html";
    }
  })
  .catch((err) => {
    if (err && err.code) {
      const errorEl = document.getElementById(
        panelSignup.classList.contains("active") ? "signup-error" : "login-error"
      );
      if (errorEl) errorEl.textContent = friendlyError(err);
    }
  })
  .finally(() => {
    handlingGoogleRedirect = false;
  });

onAuthStateChanged(auth, (user) => {
  if (user && !redirecting && !handlingGoogleRedirect) window.location.href = "chat.html";
});

const signupForm = document.getElementById("signup-form");
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = signupForm.querySelector("button[type=submit]");
  const errorEl = document.getElementById("signup-error");
  errorEl.textContent = "";

  const displayName = document.getElementById("signup-name").value.trim();
  const username = document.getElementById("signup-username").value.trim().toLowerCase();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    errorEl.textContent = "Username: 3-20 chars, lowercase letters, numbers, underscore only.";
    return;
  }

  setLoading(btn, true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    await createUserProfile(cred.user, { displayName, username, email, photoURL: null });
    redirecting = true;
    window.location.href = "chat.html";
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    setLoading(btn, false);
  }
});

const loginForm = document.getElementById("login-form");
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector("button[type=submit]");
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  setLoading(btn, true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    redirecting = true;
    window.location.href = "chat.html";
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    setLoading(btn, false);
  }
});

const googleButtons = document.querySelectorAll(".google-btn");
googleButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const errorEl = document.getElementById(
      panelSignup.classList.contains("active") ? "signup-error" : "login-error"
    );
    errorEl.textContent = "";
    setLoading(btn, true, true);
    try {
      // signInWithRedirect navigates away from the page; the result is
      // picked up by getRedirectResult() above when the user comes back.
      await signInWithRedirect(auth, googleProvider);
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      setLoading(btn, false, true);
    }
  });
});

async function createUserProfile(user, { displayName, username, email, photoURL }) {
  await setDoc(doc(db, "users", user.uid), {
    uid: user.uid,
    displayName,
    username,
    usernameLower: username.toLowerCase(),
    email,
    photoURL,
    role: "member",
    status: "offline",
    createdAt: serverTimestamp(),
  });
}

function generateUsername(email, displayName) {
  const base = (displayName || email || "user")
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 14) || "user";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${base}${suffix}`.slice(0, 20);
}

function setLoading(btn, isLoading, isGoogle) {
  btn.disabled = isLoading;
  if (isGoogle) {
    btn.innerHTML = isLoading ? '<span class="spin spin-dark"></span>' : btn.dataset.label;
  } else {
    btn.innerHTML = isLoading ? '<span class="spin"></span>' : btn.dataset.label;
  }
}

function friendlyError(err) {
  const map = {
    "auth/email-already-in-use": "That email is already registered.",
    "auth/invalid-email": "That email address looks invalid.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/popup-blocked": "Your browser blocked the Google sign-in popup.",
    "auth/account-exists-with-different-credential": "That email is already registered with a password. Log in with email instead.",
  };
  return map[err.code] || "Something went wrong. Try again.";
}
