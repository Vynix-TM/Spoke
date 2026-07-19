import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyDS-L-gEYafP1TlUU_wHQqjS4FIv7wQzKg",
  authDomain: "spoke-d095c.firebaseapp.com",
  projectId: "spoke-d095c",
  storageBucket: "spoke-d095c.firebasestorage.app",
  messagingSenderId: "337893785929",
  appId: "1:337893785929:web:9f790d015b111673c41a98",
  measurementId: "G-VKW82EEDXM",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

export let analytics = null;
isSupported().then((ok) => {
  if (ok) analytics = getAnalytics(app);
});
