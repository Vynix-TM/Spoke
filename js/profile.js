import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const main = document.getElementById("profile-page-main");
const toastEl = document.getElementById("toast");
const backBtn = document.getElementById("profile-page-back");

backBtn.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "chat.html";
});

// Keep this in sync with js/chat.js — same verification rule.
const VERIFIED_EMAILS = ["leomh312@gmail.com", "vynixteam47@gmail.com", "leomh2@gmail.com", "zawali441378@gmail.com"];
function isVerified(u) {
  if (!u) return false;
  if (u.verified === true) return true;
  const email = (u.email || "").toLowerCase();
  return !!email && VERIFIED_EMAILS.includes(email);
}
const VERIFIED_BADGE_SVG = `<img class="verified-badge" src="assets/verified.png" alt="Verified">`;
function verifiedBadge(u) {
  return isVerified(u) ? VERIFIED_BADGE_SVG : "";
}

function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
}
function avatarInner(name, photoURL) {
  if (photoURL) return `<img src="${escapeHtml(photoURL)}" alt="" class="avatar-img">`;
  return escapeHtml(initials(name));
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3000);
}

const params = new URLSearchParams(window.location.search);
const targetUid = params.get("uid");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  if (!targetUid) {
    main.innerHTML = `<div class="empty-state">No profile specified.</div>`;
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", targetUid));
    if (!snap.exists()) {
      main.innerHTML = `<div class="empty-state">This user couldn't be found.</div>`;
      return;
    }
    const data = snap.data();
    const isOwn = targetUid === user.uid;
    renderProfile(data, isOwn);
  } catch (err) {
    console.error("profile load failed:", err);
    main.innerHTML = `<div class="empty-state">Couldn't load this profile.</div>`;
  }
});

function renderProfile(data, isOwn) {
  const statusOnline = data.status === "online";
  main.innerHTML = `
    <div class="profile-page-card">
      <div class="profile-avatar-wrap" style="width:112px;height:112px;">
        <div class="avatar" style="width:112px;height:112px;font-size:34px;">${avatarInner(data.displayName, data.photoURL)}</div>
      </div>
      <div class="profile-name">${escapeHtml(data.displayName || "")}${verifiedBadge(data)}${data.role && data.role !== "member" ? `<span class="staff-pill">${data.role}</span>` : ""}</div>
      <div class="profile-username">@${escapeHtml(data.username || "")}</div>
      <div class="profile-status${statusOnline ? " online" : ""}">${statusOnline ? "Online" : "Offline"}</div>
      <div class="profile-bio">${data.bio ? escapeHtml(data.bio) : '<span style="color:var(--text-low);">No bio yet.</span>'}</div>
      ${isOwn
        ? `<div class="profile-actions"><a class="btn btn-primary" href="chat.html">Back to Spoke</a></div>`
        : `<div class="profile-actions"><button class="btn btn-primary" id="profile-page-message-btn" type="button">Message</button></div>`
      }
    </div>
  `;

  if (!isOwn) {
    document.getElementById("profile-page-message-btn").addEventListener("click", () => {
      window.location.href = `chat.html?dm=${encodeURIComponent(new URLSearchParams(window.location.search).get("uid"))}`;
    });
  }
}
