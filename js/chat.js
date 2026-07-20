import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp,
  collection, query, where, orderBy, limit, writeBatch,
  onSnapshot, addDoc, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let CURRENT_USER = null;
let AUTH_USER = null; // raw Firebase Auth user (needed for password change / email)
let ACTIVE_CONVO = null;
let ACTIVE_CONVO_DATA = null; // { status, requestedBy, ... } of the open thread's conversation doc
let unsubMessages = null;
let unsubConvos = null;

let VIEW = "chats";           // "chats" | "friends"
let FRIEND_SUBTAB = "friends"; // "friends" | "requests"
const CONVOS = new Map();      // convoId -> conversation data, kept in sync by listenToConversations

const els = {
  convoScroll: document.getElementById("convo-scroll"),
  threadScroll: document.getElementById("thread-scroll"),
  threadHead: document.getElementById("thread-head"),
  threadBottomBar: document.getElementById("thread-bottom-bar"),
  threadEmpty: document.getElementById("thread-empty"),
  threadActive: document.getElementById("thread-active"),
  composer: document.getElementById("composer"),
  msgInput: document.getElementById("msg-input"),
  sendBtn: document.getElementById("send-btn"),
  searchInput: document.getElementById("search-input"),
  searchResults: document.getElementById("search-results"),
  railAvatar: document.getElementById("rail-avatar"),
  signOutBtn: document.getElementById("sign-out-btn"),
  backBtn: document.getElementById("back-btn"),
  appShell: document.getElementById("app-shell"),
  toast: document.getElementById("toast"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsClose: document.getElementById("settings-close"),
  themeOptions: document.getElementById("theme-options"),
  toggleSound: document.getElementById("toggle-sound"),
  toggleSpokeField: document.getElementById("toggle-spoke-field"),
  toggleDesktopNotif: document.getElementById("toggle-desktop-notif"),
  threadIdentity: document.getElementById("thread-identity"),
  threadAvatar: document.getElementById("thread-avatar"),
  profileOverlay: document.getElementById("profile-overlay"),
  profileClose: document.getElementById("profile-close"),
  profileBody: document.getElementById("profile-body"),
  avatarFileInput: document.getElementById("avatar-file-input"),

  railChatsBtn: document.getElementById("rail-chats-btn"),
  railFriendsBtn: document.getElementById("rail-friends-btn"),
  railFriendsBadge: document.getElementById("rail-friends-badge"),
  listTitle: document.getElementById("list-title"),
  friendSubtabs: document.getElementById("friend-subtabs"),
  subtabRequestsBadge: document.getElementById("subtab-requests-badge"),
  friendsScroll: document.getElementById("friends-scroll"),
  requestsScroll: document.getElementById("requests-scroll"),

  requestBanner: document.getElementById("request-banner"),
  requestBannerName: document.getElementById("request-banner-name"),
  requestAcceptBtn: document.getElementById("request-accept-btn"),
  requestDeclineBtn: document.getElementById("request-decline-btn"),
  pendingHint: document.getElementById("pending-hint"),

  accountPasswordBlock: document.getElementById("account-password-block"),
  accountGoogleNote: document.getElementById("account-google-note"),
  accountCurrentPassword: document.getElementById("account-current-password"),
  accountNewPassword: document.getElementById("account-new-password"),
  accountConfirmPassword: document.getElementById("account-confirm-password"),
  accountPasswordError: document.getElementById("account-password-error"),
  accountPasswordSave: document.getElementById("account-password-save"),

  replyPreview: document.getElementById("reply-preview"),
  replyPreviewName: document.getElementById("reply-preview-name"),
  replyPreviewText: document.getElementById("reply-preview-text"),
  replyPreviewClose: document.getElementById("reply-preview-close"),

  callStartBtn: document.getElementById("call-start-btn"),
  callIncoming: document.getElementById("call-incoming"),
  callIncomingAvatar: document.getElementById("call-incoming-avatar"),
  callIncomingName: document.getElementById("call-incoming-name"),
  callAcceptBtn: document.getElementById("call-accept-btn"),
  callDeclineBtn: document.getElementById("call-decline-btn"),
  callScreen: document.getElementById("call-screen"),
  callScreenAvatar: document.getElementById("call-screen-avatar"),
  callScreenName: document.getElementById("call-screen-name"),
  callScreenStatus: document.getElementById("call-screen-status"),
  callMuteBtn: document.getElementById("call-mute-btn"),
  callHangupBtn: document.getElementById("call-hangup-btn"),
  callRemoteAudio: document.getElementById("call-remote-audio"),
  callAvatarRing: document.getElementById("call-avatar-ring"),
  callScreenTimer: document.getElementById("call-screen-timer"),
  callMicSelectBtn: document.getElementById("call-mic-select-btn"),
  callSpeakerBtn: document.getElementById("call-speaker-btn"),
  micMenu: document.getElementById("mic-menu"),
};

let REPLY_TARGET = null; // { msgId, text, senderName, senderId } | null
let msgMenuEl = null;    // currently open message action menu, if any

const CLOUDINARY_CLOUD = "ylw98ola";
const CLOUDINARY_PRESET = "spoke_avatars";
const MAX_AVATAR_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_BIO_LEN = 190;

/* ---------- Verified accounts ---------- */
// Accounts get the badge either by an explicit `verified: true` field on
// their user doc, or (for this one account) by email — no manual Firestore
// edit required.
const VERIFIED_EMAILS = ["leomh312@gmail.com", "vynixteam47@gmail.com"];
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

const REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "😡", "👍"];

let ACTIVE_OTHER = null; // { uid, displayName, ... } of the currently open thread's other user
let ACTIVE_MESSAGES = new Map(); // msgId -> message data, for the currently open thread
let typingSelf = false;
let typingClearTimer = null;
let typingIndicatorEl = null;
let reactionPickerEl = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  AUTH_USER = user;
  const userRef = doc(db, "users", user.uid);
  let snap = await getDoc(userRef);
  if (!snap.exists()) {
    // Auth account exists but no Firestore profile doc — e.g. the account was
    // created outside the normal signup flow. Create a minimal profile so
    // saves/updates have a real document to target instead of failing with
    // "Missing or insufficient permissions" against a nonexistent doc.
    const fallbackUsername = (user.email ? user.email.split("@")[0] : `user${user.uid.slice(0, 6)}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 20) || `user${user.uid.slice(0, 6)}`;
    await setDoc(userRef, {
      uid: user.uid,
      displayName: user.displayName || "New user",
      username: fallbackUsername,
      usernameLower: fallbackUsername,
      email: user.email || null,
      photoURL: user.photoURL || null,
      role: "member",
      status: "offline",
      createdAt: serverTimestamp(),
    }).catch((err) => console.error("failed to create missing profile doc:", err));
    snap = await getDoc(userRef);
  }
  CURRENT_USER = snap.exists() ? snap.data() : { uid: user.uid, displayName: user.displayName, role: "member" };
  renderRailAvatar();
  updateDoc(doc(db, "users", user.uid), { status: "online" }).catch(() => {});
  window.addEventListener("beforeunload", () => {
    updateDoc(doc(db, "users", user.uid), { status: "offline" }).catch(() => {});
  });
  listenToConversations();
  listenForIncomingCalls();

  const dmUid = new URLSearchParams(window.location.search).get("dm");
  if (dmUid && dmUid !== CURRENT_USER.uid) {
    getDoc(doc(db, "users", dmUid)).then((snap) => {
      if (snap.exists()) startConversationWith(snap.data());
    }).catch(() => {});
    window.history.replaceState({}, "", "chat.html");
  }

  const savedTheme = CURRENT_USER.settings?.theme;
  if (savedTheme && savedTheme !== localStorage.getItem("spoke-theme")) {
    applyTheme(savedTheme, { persist: false });
  }
  const savedSpokeField = CURRENT_USER.settings?.spokeField;
  if (typeof savedSpokeField === "boolean" && savedSpokeField !== (localStorage.getItem("spoke-field") !== "off")) {
    applySpokeField(savedSpokeField, { persist: false });
  }
  initSettingsUI();
  initAccountUI();
});

els.signOutBtn.addEventListener("click", async () => {
  if (CURRENT_USER) {
    await updateDoc(doc(db, "users", CURRENT_USER.uid), { status: "offline" }).catch(() => {});
  }
  await signOut(auth);
});

els.railAvatar.addEventListener("click", () => openProfile(CURRENT_USER.uid));

function renderRailAvatar() {
  els.railAvatar.innerHTML = avatarInner(CURRENT_USER.displayName, CURRENT_USER.photoURL);
}

function isAccepted(data) {
  return !data.status || data.status === "accepted";
}
function otherUidOf(data) {
  return data.participants.find((p) => p !== CURRENT_USER.uid);
}

function listenToConversations() {
  const q = query(
    collection(db, "conversations"),
    where("participants", "array-contains", CURRENT_USER.uid),
    orderBy("lastMessageAt", "desc")
  );
  unsubConvos = onSnapshot(q, (snap) => {
    CONVOS.clear();
    snap.forEach((docSnap) => CONVOS.set(docSnap.id, docSnap.data()));

    const chats = [];
    const friends = [];
    const incoming = [];
    const sent = [];

    for (const [id, data] of CONVOS) {
      if (isAccepted(data)) {
        chats.push([id, data]);
        friends.push([id, data]);
      } else if (data.status === "pending") {
        if (data.requestedBy === CURRENT_USER.uid) {
          chats.push([id, data]); // my own outgoing request still lives in my main list
          sent.push([id, data]);
        } else {
          incoming.push([id, data]);
        }
      }
    }

    renderList(els.convoScroll, chats, renderConvoRow, "No conversations yet.<br>Search a username above to start one.");
    renderList(els.friendsScroll, friends, renderFriendRow, "No friends yet.<br>Accept a request or search a username to add one.");
    renderRequestsPanel(incoming, sent);

    updateRequestBadges(incoming.length);

    // keep the open thread's gating in sync if its doc changed underneath us
    if (ACTIVE_CONVO && CONVOS.has(ACTIVE_CONVO)) {
      ACTIVE_CONVO_DATA = CONVOS.get(ACTIVE_CONVO);
      updateThreadGatingUI();
      updateTypingIndicatorUI();
    }
  }, (err) => console.error("conversations listener:", err));
}

function renderList(container, entries, rowFn, emptyMsg) {
  if (!container) return;
  if (entries.length === 0) {
    container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }
  container.innerHTML = "";
  entries.forEach(([id, data]) => container.appendChild(rowFn(id, data)));
}

function updateRequestBadges(incomingCount) {
  if (els.railFriendsBadge) {
    els.railFriendsBadge.textContent = incomingCount > 9 ? "9+" : String(incomingCount);
    els.railFriendsBadge.classList.toggle("hidden", incomingCount === 0);
  }
  if (els.subtabRequestsBadge) {
    els.subtabRequestsBadge.textContent = incomingCount > 9 ? "9+" : String(incomingCount);
    els.subtabRequestsBadge.classList.toggle("hidden", incomingCount === 0);
  }
}

function renderConvoRow(id, data) {
  const otherUid = otherUidOf(data);
  const other = data.participantsInfo?.[otherUid] || { displayName: "Unknown" };
  const amPendingSender = data.status === "pending" && data.requestedBy === CURRENT_USER.uid;

  const row = document.createElement("div");
  row.className = "convo-item" + (ACTIVE_CONVO === id ? " active" : "");
  row.dataset.id = id;
  row.innerHTML = `
    <div class="avatar" data-open-profile="${otherUid}">${avatarInner(other.displayName, other.photoURL)}${other.online ? '<span class="dot"></span>' : ""}</div>
    <div class="convo-meta">
      <div class="row1">
        <span class="name" data-open-profile="${otherUid}">${escapeHtml(other.displayName)}${verifiedBadge(other)}${other.role && other.role !== "member" ? `<span class="staff-tag">${other.role}</span>` : ""}${amPendingSender ? '<span class="pending-tag">Pending</span>' : ""}</span>
        <span class="time">${formatTime(data.lastMessageAt)}</span>
      </div>
      <div class="preview">${escapeHtml(data.lastMessage || (amPendingSender ? "Message request sent" : "Say hello 👋"))}</div>
    </div>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-profile]")) {
      openProfile(otherUid);
      return;
    }
    openConversation(id, { uid: otherUid, ...other }, data);
  });
  return row;
}

function renderFriendRow(id, data) {
  const otherUid = otherUidOf(data);
  const other = data.participantsInfo?.[otherUid] || { displayName: "Unknown" };

  const row = document.createElement("div");
  row.className = "convo-item" + (ACTIVE_CONVO === id ? " active" : "");
  row.dataset.id = id;
  row.innerHTML = `
    <div class="avatar" data-open-profile="${otherUid}">${avatarInner(other.displayName, other.photoURL)}${other.online ? '<span class="dot"></span>' : ""}</div>
    <div class="convo-meta">
      <div class="row1">
        <span class="name" data-open-profile="${otherUid}">${escapeHtml(other.displayName)}${verifiedBadge(other)}${other.role && other.role !== "member" ? `<span class="staff-tag">${other.role}</span>` : ""}</span>
      </div>
      <div class="preview">${other.online ? "Online" : "Offline"}</div>
    </div>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-profile]")) {
      openProfile(otherUid);
      return;
    }
    openConversation(id, { uid: otherUid, ...other }, data);
  });
  return row;
}

function renderRequestsPanel(incoming, sent) {
  if (!els.requestsScroll) return;
  if (incoming.length === 0 && sent.length === 0) {
    els.requestsScroll.innerHTML = `<div class="empty-state">No pending requests.</div>`;
    return;
  }
  els.requestsScroll.innerHTML = "";

  if (incoming.length) {
    els.requestsScroll.appendChild(sectionHeader("Incoming"));
    incoming.forEach(([id, data]) => els.requestsScroll.appendChild(renderRequestRow(id, data, "incoming")));
  }
  if (sent.length) {
    els.requestsScroll.appendChild(sectionHeader("Sent"));
    sent.forEach(([id, data]) => els.requestsScroll.appendChild(renderRequestRow(id, data, "sent")));
  }
}

function sectionHeader(label) {
  const h = document.createElement("div");
  h.style.cssText = "padding:10px 12px 6px;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-low);";
  h.textContent = label;
  return h;
}

function renderRequestRow(id, data, kind) {
  const otherUid = otherUidOf(data);
  const other = data.participantsInfo?.[otherUid] || { displayName: "Unknown" };

  const row = document.createElement("div");
  row.className = "convo-item" + (ACTIVE_CONVO === id ? " active" : "");
  row.dataset.id = id;

  const actionsHtml = kind === "incoming"
    ? `<div class="row-actions">
         <button class="icon-btn decline" data-decline="${id}" title="Decline" type="button">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
         </button>
         <button class="icon-btn accept" data-accept="${id}" title="Accept" type="button">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6L9 17l-5-5"/></svg>
         </button>
       </div>`
    : `<div class="row-actions">
         <button class="icon-btn decline" data-cancel="${id}" title="Cancel request" type="button">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
         </button>
       </div>`;

  row.innerHTML = `
    <div class="avatar" data-open-profile="${otherUid}">${avatarInner(other.displayName, other.photoURL)}${other.online ? '<span class="dot"></span>' : ""}</div>
    <div class="convo-meta">
      <div class="row1">
        <span class="name" data-open-profile="${otherUid}">${escapeHtml(other.displayName)}${verifiedBadge(other)}</span>
      </div>
      <div class="preview">${kind === "incoming" ? "Wants to message you" : "Request pending"}</div>
    </div>
    ${actionsHtml}
  `;

  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-profile]")) {
      openProfile(otherUid);
      return;
    }
    if (e.target.closest("[data-accept]")) {
      acceptRequest(id);
      return;
    }
    if (e.target.closest("[data-decline], [data-cancel]")) {
      declineRequest(id);
      return;
    }
    openConversation(id, { uid: otherUid, ...other }, data);
  });
  return row;
}

async function acceptRequest(convoId) {
  try {
    await updateDoc(doc(db, "conversations", convoId), { status: "accepted" });
    showToast("Friend request accepted.");
  } catch (err) {
    console.error("accept request failed:", err);
    showToast("Couldn't accept that request.");
  }
}

async function declineRequest(convoId) {
  try {
    await deleteDoc(doc(db, "conversations", convoId));
    if (ACTIVE_CONVO === convoId) {
      els.appShell.classList.remove("thread-open");
      els.threadActive.classList.add("hidden");
      els.threadEmpty.classList.remove("hidden");
      ACTIVE_CONVO = null;
      ACTIVE_CONVO_DATA = null;
    }
  } catch (err) {
    console.error("decline/cancel request failed:", err);
    showToast("Couldn't remove that request.");
  }
}

/* ---------- Chats / Friends view switching ---------- */
function setView(view) {
  VIEW = view;
  els.railChatsBtn.classList.toggle("active", view === "chats");
  els.railFriendsBtn.classList.toggle("active", view === "friends");
  els.listTitle.textContent = view === "chats" ? "Messages" : "Friends";

  els.convoScroll.classList.toggle("hidden", view !== "chats");
  els.friendSubtabs.classList.toggle("hidden", view !== "friends");
  els.friendsScroll.classList.toggle("hidden", !(view === "friends" && FRIEND_SUBTAB === "friends"));
  els.requestsScroll.classList.toggle("hidden", !(view === "friends" && FRIEND_SUBTAB === "requests"));
}

function setFriendSubtab(tab) {
  FRIEND_SUBTAB = tab;
  document.querySelectorAll(".friend-subtab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtab === tab);
  });
  els.friendsScroll.classList.toggle("hidden", tab !== "friends");
  els.requestsScroll.classList.toggle("hidden", tab !== "requests");
}

els.railChatsBtn.addEventListener("click", () => setView("chats"));
els.railFriendsBtn.addEventListener("click", () => setView("friends"));
if (els.friendSubtabs) {
  els.friendSubtabs.querySelectorAll(".friend-subtab").forEach((btn) => {
    btn.addEventListener("click", () => setFriendSubtab(btn.dataset.subtab));
  });
}

els.requestAcceptBtn?.addEventListener("click", () => { if (ACTIVE_CONVO) acceptRequest(ACTIVE_CONVO); });
els.requestDeclineBtn?.addEventListener("click", () => { if (ACTIVE_CONVO) declineRequest(ACTIVE_CONVO); });

let searchDebounce;
els.searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const term = els.searchInput.value.trim().toLowerCase();
  if (!term) {
    els.searchResults.classList.remove("show");
    return;
  }
  searchDebounce = setTimeout(() => runUserSearch(term), 250);
});

document.addEventListener("click", (e) => {
  if (!els.searchResults.contains(e.target) && e.target !== els.searchInput) {
    els.searchResults.classList.remove("show");
  }
});

async function runUserSearch(term) {
  try {
    const q = query(
      collection(db, "users"),
      orderBy("usernameLower"),
      where("usernameLower", ">=", term),
      where("usernameLower", "<=", term + "\uf8ff"),
      limit(8)
    );
    const snap = await getDocs(q);
    els.searchResults.innerHTML = "";
    let count = 0;
    snap.forEach((docSnap) => {
      const u = docSnap.data();
      if (u.uid === CURRENT_USER.uid) return;
      count++;
      const row = document.createElement("div");
      row.className = "search-row";
      row.innerHTML = `
        <div class="avatar" style="width:32px;height:32px;font-size:12px;">${avatarInner(u.displayName, u.photoURL)}</div>
        <div>
          <div style="font-size:13.5px;font-weight:600;">${escapeHtml(u.displayName)}${verifiedBadge(u)}</div>
          <div style="font-size:11.5px;color:var(--text-low);">@${escapeHtml(u.username)}</div>
        </div>
      `;
      row.addEventListener("click", () => startConversationWith(u));
      els.searchResults.appendChild(row);
    });
    if (count === 0) {
      els.searchResults.innerHTML = `<div class="search-row" style="color:var(--text-low);">No users found</div>`;
    }
    els.searchResults.classList.add("show");
  } catch (err) {
    console.error("user search failed:", err);
    showToast("Search failed — check your connection.");
  }
}

async function startConversationWith(otherUser) {
  els.searchResults.classList.remove("show");
  els.searchInput.value = "";

  const convoId = [CURRENT_USER.uid, otherUser.uid].sort().join("_");
  const convoRef = doc(db, "conversations", convoId);
  const existing = await getDoc(convoRef);

  let convoData;
  if (!existing.exists()) {
    convoData = {
      participants: [CURRENT_USER.uid, otherUser.uid].sort(),
      participantsInfo: {
        [CURRENT_USER.uid]: { displayName: CURRENT_USER.displayName, username: CURRENT_USER.username, role: CURRENT_USER.role || "member", photoURL: CURRENT_USER.photoURL || null, email: CURRENT_USER.email || null, verified: isVerified(CURRENT_USER) },
        [otherUser.uid]: { displayName: otherUser.displayName, username: otherUser.username, role: otherUser.role || "member", photoURL: otherUser.photoURL || null, email: otherUser.email || null, verified: isVerified(otherUser) },
      },
      status: "pending",
      requestedBy: CURRENT_USER.uid,
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    };
    await setDoc(convoRef, convoData);
  } else {
    convoData = existing.data();
  }
  CONVOS.set(convoId, convoData);
  openConversation(convoId, otherUser, convoData);
}

function openConversation(convoId, other, convoData) {
  ACTIVE_CONVO = convoId;
  ACTIVE_OTHER = other;
  ACTIVE_CONVO_DATA = convoData || CONVOS.get(convoId) || null;
  clearReplyTarget();

  // Conversations created before verified badges existed won't have
  // email/verified on file for the other participant — backfill it once.
  if (other?.uid && other.email === undefined && other.verified === undefined) {
    getDoc(doc(db, "users", other.uid)).then((snap) => {
      if (!snap.exists()) return;
      const full = snap.data();
      const patch = { email: full.email || null, verified: isVerified(full) };
      Object.assign(other, patch);
      if (ACTIVE_OTHER === other) {
        els.threadHead.querySelector(".name").innerHTML =
          escapeHtml(other.displayName) + verifiedBadge(other) +
          (other.role && other.role !== "member" ? `<span class="staff-pill">${other.role}</span>` : "");
      }
      updateDoc(doc(db, "conversations", convoId), { [`participantsInfo.${other.uid}.email`]: patch.email, [`participantsInfo.${other.uid}.verified`]: patch.verified }).catch(() => {});
    }).catch(() => {});
  }
  document.querySelectorAll(".convo-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === convoId);
  });

  els.threadEmpty.classList.add("hidden");
  els.threadActive.classList.remove("hidden");
  els.appShell.classList.add("thread-open");
  fitThreadScroll();

  els.threadAvatar.innerHTML = avatarInner(other.displayName, other.photoURL);
  els.threadHead.querySelector(".name").innerHTML =
    escapeHtml(other.displayName) +
    verifiedBadge(other) +
    (other.role && other.role !== "member" ? `<span class="staff-pill">${other.role}</span>` : "");

  updateThreadGatingUI();

  if (unsubMessages) unsubMessages();
  ACTIVE_MESSAGES = new Map(); // msgId -> { data, row }
  els.threadScroll.innerHTML = "";
  ensureTypingIndicatorEl();
  let lastRenderedDay = null;
  let currentStatusRow = null;
  const skipStatusWrite = new Set(); // avoid retry storms if a write is ever rejected
  let firstLoad = true;

  const q = query(
    collection(db, "conversations", convoId, "messages"),
    orderBy("createdAt", "asc")
  );
  unsubMessages = onSnapshot(q, (snap) => {
    const nearBottom = firstLoad ||
      (els.threadScroll.scrollHeight - els.threadScroll.scrollTop - els.threadScroll.clientHeight < 120);
    const distanceFromBottom = els.threadScroll.scrollHeight - els.threadScroll.scrollTop - els.threadScroll.clientHeight;

    const toDeliver = [];
    const toSeen = [];

    snap.docChanges().forEach((change) => {
      const id = change.doc.id;

      if (change.type === "removed") {
        ACTIVE_MESSAGES.get(id)?.row?.remove();
        ACTIVE_MESSAGES.delete(id);
        return;
      }

      const m = change.doc.data();
      const existing = ACTIVE_MESSAGES.get(id);

      if (existing) {
        // In place refresh — reactions, edits, or deletes changed; the
        // sender/time never do, so the row itself doesn't get rebuilt.
        const textChanged = existing.data.text !== m.text || existing.data.deleted !== m.deleted || existing.data.editedAt !== m.editedAt;
        existing.data = m;
        if (textChanged) {
          const bubble = existing.row.querySelector(".msg-bubble");
          bubble.innerHTML = bubbleInnerHTML(m);
          if (m.deleted) existing.row.querySelectorAll(".msg-actions").forEach((a) => a.remove());
        }
        renderReactionChips(existing.row, m, id, convoId);
      } else {
        const day = formatDay(m.createdAt);
        if (day !== lastRenderedDay) {
          const divider = document.createElement("div");
          divider.className = "day-divider";
          divider.textContent = day;
          insertBeforeTyping(divider);
          lastRenderedDay = day;
        }
        const row = buildMessageRow(m, id, convoId);
        insertBeforeTyping(row);
        ACTIVE_MESSAGES.set(id, { data: m, row });
      }

      if (m.senderId !== CURRENT_USER.uid && change.type === "added" && !skipStatusWrite.has(id)) {
        if (!m.status || m.status === "sent") toDeliver.push(change.doc.ref);
        if (document.hasFocus() && ACTIVE_CONVO === convoId && m.status !== "seen") toSeen.push({ ref: change.doc.ref, id });
      }
    });

    // Status text ("Sent" / "Delivered" / "Seen") only under the very
    // last message, and only when it's mine — matches Instagram/Messenger.
    if (currentStatusRow) {
      currentStatusRow.querySelector(".msg-status")?.remove();
      currentStatusRow = null;
    }
    const ids = [...ACTIVE_MESSAGES.keys()];
    const lastId = ids[ids.length - 1];
    if (lastId) {
      const last = ACTIVE_MESSAGES.get(lastId);
      if (last.data.senderId === CURRENT_USER.uid) {
        const statusEl = document.createElement("div");
        statusEl.className = "msg-status";
        statusEl.textContent = last.data.status === "seen" ? "Seen" : last.data.status === "delivered" ? "Delivered" : "Sent";
        last.row.appendChild(statusEl);
        currentStatusRow = last.row;
      }
    }

    updateTypingIndicatorUI();

    if (nearBottom) {
      els.threadScroll.scrollTo({ top: els.threadScroll.scrollHeight, behavior: firstLoad ? "auto" : "smooth" });
    } else {
      // Preserve reading position exactly — this one must be instant,
      // not smooth, or the compensating jump would itself be visible.
      els.threadScroll.scrollTop = els.threadScroll.scrollHeight - els.threadScroll.clientHeight - distanceFromBottom;
    }
    firstLoad = false;

    // Delivery/read receipts: the RECIPIENT advances status, never the
    // sender. Batched into a single commit (instead of one write per
    // message) so a burst of messages doesn't cascade into a burst of
    // extra snapshot re-fires — that cascade is what made messages feel
    // like they arrived late.
    if (toDeliver.length || toSeen.length) {
      const batch = writeBatch(db);
      const seenIds = new Set(toSeen.map((x) => x.id));
      toDeliver.forEach((ref) => {
        if (!seenIds.has(ref.id)) batch.update(ref, { status: "delivered" });
      });
      toSeen.forEach(({ ref }) => batch.update(ref, { status: "seen" }));
      batch.commit().catch((err) => {
        // Most likely cause: the Firestore security rules haven't been
        // redeployed yet. Don't keep retrying every snapshot — that's
        // what causes the write queue (and message delivery) to lag.
        console.error("status update failed — have the updated firestore.rules been deployed?", err);
        toDeliver.forEach((ref) => skipStatusWrite.add(ref.id));
        toSeen.forEach(({ id }) => skipStatusWrite.add(id));
      });
    }
  }, (err) => console.error("messages listener:", err));
}

function insertBeforeTyping(el) {
  if (typingIndicatorEl && typingIndicatorEl.parentNode === els.threadScroll) {
    els.threadScroll.insertBefore(el, typingIndicatorEl);
  } else {
    els.threadScroll.appendChild(el);
  }
}

window.addEventListener("focus", () => {
  if (!ACTIVE_CONVO || !ACTIVE_MESSAGES.size) return;
  const batch = writeBatch(db);
  let any = false;
  for (const [id, entry] of ACTIVE_MESSAGES) {
    const m = entry.data;
    if (m.senderId === CURRENT_USER.uid) continue;
    if (m.status !== "seen") {
      batch.update(doc(db, "conversations", ACTIVE_CONVO, "messages", id), { status: "seen" });
      any = true;
    }
  }
  if (any) batch.commit().catch((err) => console.error("mark-seen failed — have the updated firestore.rules been deployed?", err));
});

// Shows/hides the request banner, pending hint, and disables the composer
// for the currently open thread, based on ACTIVE_CONVO_DATA.
function updateThreadGatingUI() {
  const data = ACTIVE_CONVO_DATA;
  const isPending = data?.status === "pending";
  const amRequester = data?.requestedBy === CURRENT_USER.uid;

  const iMustAccept = isPending && !amRequester;
  const iAmWaiting = isPending && amRequester;

  els.requestBanner.classList.toggle("hidden", !iMustAccept);
  els.pendingHint.classList.toggle("hidden", !iAmWaiting);

  if (iMustAccept && ACTIVE_OTHER) {
    els.requestBannerName.textContent = ACTIVE_OTHER.displayName || "This user";
  }

  els.msgInput.disabled = iMustAccept;
  els.sendBtn.disabled = iMustAccept;
  els.msgInput.placeholder = iMustAccept ? "Accept the request to reply…" : "Message…";
  if (els.callStartBtn) els.callStartBtn.classList.toggle("hidden", isPending);
}

function bubbleInnerHTML(m) {
  const isMine = m.senderId === CURRENT_USER.uid;
  if (m.deleted) {
    return `<span class="deleted-text">${isMine ? "You deleted this message" : "This message was deleted"}</span><span class="msg-time">${formatTime(m.createdAt)}</span>`;
  }
  const quote = m.replyTo
    ? `<div class="msg-reply-quote" data-reply-jump="${m.replyTo.msgId}">
         <span class="rq-name">${escapeHtml(m.replyTo.senderName || "")}</span>
         <span class="rq-text">${escapeHtml(m.replyTo.text || "")}</span>
       </div>`
    : "";
  const editedTag = m.editedAt ? `<span class="msg-edited-tag">(edited)</span>` : "";
  return `${quote}${escapeHtml(m.text)}<span class="msg-time">${formatTime(m.createdAt)}${editedTag}</span>`;
}

function buildMessageRow(m, msgId, convoId) {
  const row = document.createElement("div");
  const isMine = m.senderId === CURRENT_USER.uid;
  row.className = "msg-row " + (isMine ? "me" : "them");
  row.dataset.msgId = msgId;

  const replyBtn = `<button class="msg-action-btn" data-action="reply" title="Reply">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a5 5 0 0 1 5 5v2"/></svg>
  </button>`;
  const editBtn = `<button class="msg-action-btn" data-action="edit" title="Edit">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
  </button>`;
  const deleteBtn = `<button class="msg-action-btn" data-action="delete" title="Delete">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
  </button>`;
  const actions = m.deleted ? "" : `<div class="msg-actions">${replyBtn}${isMine ? editBtn + deleteBtn : ""}</div>`;

  row.innerHTML = `
    <div class="msg-row-inner">
      ${isMine ? actions : ""}
      <div class="msg-bubble">${bubbleInnerHTML(m)}</div>
      ${isMine ? "" : actions}
    </div>
    <div class="msg-reactions"></div>
  `;
  const bubble = row.querySelector(".msg-bubble");
  renderReactionChips(row, m, msgId, convoId);

  // Desktop: double-click. Mobile: long-press (touch held ~450ms without moving).
  if (!m.deleted) {
    bubble.addEventListener("dblclick", () => openReactionPicker(bubble, ACTIVE_MESSAGES.get(msgId)?.data || m, msgId, convoId));
    let pressTimer = null;
    bubble.addEventListener("touchstart", () => {
      pressTimer = setTimeout(() => openReactionPicker(bubble, ACTIVE_MESSAGES.get(msgId)?.data || m, msgId, convoId), 450);
    }, { passive: true });
    bubble.addEventListener("touchend", () => clearTimeout(pressTimer));
    bubble.addEventListener("touchmove", () => clearTimeout(pressTimer));
  }

  row.querySelectorAll(".msg-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const current = ACTIVE_MESSAGES.get(msgId)?.data || m;
      if (action === "reply") setReplyTarget(msgId, current);
      else if (action === "edit") startEditMessage(row, msgId, convoId, current);
      else if (action === "delete") deleteMessage(msgId, convoId, current);
    });
  });

  bubble.addEventListener("click", (e) => {
    const quoteEl = e.target.closest("[data-reply-jump]");
    if (quoteEl) jumpToMessage(quoteEl.dataset.replyJump);
  });

  return row;
}

function jumpToMessage(msgId) {
  const target = ACTIVE_MESSAGES.get(msgId);
  if (!target) return;
  target.row.scrollIntoView({ behavior: "smooth", block: "center" });
  target.row.classList.add("flash");
  setTimeout(() => target.row.classList.remove("flash"), 1100);
}

function renderReactionChips(row, m, msgId, convoId) {
  const wrap = row.querySelector(".msg-reactions");
  const reactions = m.reactions || {};
  const byEmoji = new Map();
  for (const [uid, emoji] of Object.entries(reactions)) {
    if (!byEmoji.has(emoji)) byEmoji.set(emoji, []);
    byEmoji.get(emoji).push(uid);
  }
  wrap.innerHTML = "";
  if (byEmoji.size === 0) return;
  for (const [emoji, uids] of byEmoji) {
    const mine = uids.includes(CURRENT_USER.uid);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction-chip" + (mine ? " mine" : "");
    chip.innerHTML = `<span>${emoji}</span>${uids.length > 1 ? `<span>${uids.length}</span>` : ""}`;
    chip.addEventListener("click", () => toggleReaction(msgId, convoId, emoji, mine));
    wrap.appendChild(chip);
  }
}

function openReactionPicker(bubble, m, msgId, convoId) {
  closeReactionPicker();
  const myEmoji = (m.reactions || {})[CURRENT_USER.uid];
  const picker = document.createElement("div");
  picker.className = "reaction-picker";
  REACTION_EMOJIS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    if (emoji === myEmoji) btn.classList.add("active");
    btn.addEventListener("click", () => {
      toggleReaction(msgId, convoId, emoji, emoji === myEmoji);
      closeReactionPicker();
    });
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);
  const bubbleRect = bubble.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  let left = bubbleRect.left + bubbleRect.width / 2 - pickerRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
  let top = bubbleRect.top - pickerRect.height - 10;
  if (top < 8) top = bubbleRect.bottom + 10;
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  reactionPickerEl = picker;
  setTimeout(() => document.addEventListener("click", onOutsideReactionPickerClick), 0);
}
function onOutsideReactionPickerClick(e) {
  if (reactionPickerEl && !reactionPickerEl.contains(e.target)) closeReactionPicker();
}
function closeReactionPicker() {
  if (reactionPickerEl) {
    reactionPickerEl.remove();
    reactionPickerEl = null;
    document.removeEventListener("click", onOutsideReactionPickerClick);
  }
}

async function toggleReaction(msgId, convoId, emoji, removeIt) {
  navigator.vibrate?.(6);
  const msgRef = doc(db, "conversations", convoId, "messages", msgId);
  try {
    await updateDoc(msgRef, {
      [`reactions.${CURRENT_USER.uid}`]: removeIt ? deleteField() : emoji,
    });
  } catch (err) {
    console.error("reaction failed:", err);
    showToast("Couldn't add that reaction.");
  }
}

/* ---------- Reply ---------- */
function setReplyTarget(msgId, data) {
  if (data.deleted) return;
  const isMine = data.senderId === CURRENT_USER.uid;
  REPLY_TARGET = {
    msgId,
    text: data.text || "",
    senderId: data.senderId,
    senderName: isMine ? "You" : (ACTIVE_OTHER?.displayName || "them"),
  };
  els.replyPreviewName.textContent = REPLY_TARGET.senderName;
  els.replyPreviewText.textContent = REPLY_TARGET.text;
  els.replyPreview.classList.remove("hidden");
  els.msgInput.focus();
}
function clearReplyTarget() {
  REPLY_TARGET = null;
  els.replyPreview.classList.add("hidden");
}
els.replyPreviewClose?.addEventListener("click", clearReplyTarget);

/* ---------- Edit ---------- */
function startEditMessage(row, msgId, convoId, data) {
  if (data.deleted) return;
  closeMsgMenu();
  const bubble = row.querySelector(".msg-bubble");
  const original = data.text || "";
  bubble.classList.add("editing");
  bubble.innerHTML = `
    <textarea class="msg-edit-input" rows="1">${escapeHtml(original)}</textarea>
    <div class="msg-edit-actions">
      <button type="button" class="msg-edit-save">Save</button>
      <button type="button" class="msg-edit-cancel">Cancel</button>
    </div>
  `;
  const input = bubble.querySelector(".msg-edit-input");
  input.style.height = input.scrollHeight + "px";
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const cancel = () => {
    bubble.classList.remove("editing");
    bubble.innerHTML = bubbleInnerHTML(ACTIVE_MESSAGES.get(msgId)?.data || data);
  };
  const save = async () => {
    const newText = input.value.trim();
    if (!newText) return cancel();
    if (newText === original) return cancel();
    try {
      await updateDoc(doc(db, "conversations", convoId, "messages", msgId), {
        text: newText,
        editedAt: serverTimestamp(),
      });
      cancel();
    } catch (err) {
      console.error("edit failed:", err);
      showToast("Couldn't save that edit.");
    }
  };

  bubble.querySelector(".msg-edit-save").addEventListener("click", save);
  bubble.querySelector(".msg-edit-cancel").addEventListener("click", cancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === "Escape") cancel();
  });
}

/* ---------- Delete ---------- */
async function deleteMessage(msgId, convoId, data) {
  if (data.deleted) return;
  if (!confirm("Delete this message? This can't be undone.")) return;
  try {
    await updateDoc(doc(db, "conversations", convoId, "messages", msgId), {
      deleted: true,
      text: "",
      replyTo: deleteField(),
      reactions: {},
    });
  } catch (err) {
    console.error("delete failed:", err);
    showToast("Couldn't delete that message.");
  }
}

function closeMsgMenu() {
  if (msgMenuEl) { msgMenuEl.remove(); msgMenuEl = null; }
}

/* ---------- Typing indicator ---------- */
function ensureTypingIndicatorEl() {
  typingIndicatorEl = document.createElement("div");
  typingIndicatorEl.className = "msg-row them hidden";
  typingIndicatorEl.id = "typing-indicator-row";
  typingIndicatorEl.innerHTML = `
    <div class="typing-bubble">
      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
    </div>
  `;
  els.threadScroll.appendChild(typingIndicatorEl);
}
function updateTypingIndicatorUI() {
  if (!typingIndicatorEl || !ACTIVE_OTHER) return;
  const otherTyping = !!ACTIVE_CONVO_DATA?.typing?.[ACTIVE_OTHER.uid];
  const wasHidden = typingIndicatorEl.classList.contains("hidden");
  typingIndicatorEl.classList.toggle("hidden", !otherTyping);
  if (otherTyping && wasHidden) {
    const nearBottom = els.threadScroll.scrollHeight - els.threadScroll.scrollTop - els.threadScroll.clientHeight < 120;
    if (nearBottom) els.threadScroll.scrollTop = els.threadScroll.scrollHeight;
  }
}
function setTyping(isTyping) {
  if (!ACTIVE_CONVO || !CURRENT_USER) return;
  if (isTyping === typingSelf) return;
  typingSelf = isTyping;
  updateDoc(doc(db, "conversations", ACTIVE_CONVO), { [`typing.${CURRENT_USER.uid}`]: isTyping }).catch(() => {});
}
els.msgInput.addEventListener("input", () => {
  if (!ACTIVE_CONVO) return;
  setTyping(true);
  clearTimeout(typingClearTimer);
  typingClearTimer = setTimeout(() => setTyping(false), 2500);
});
els.msgInput.addEventListener("blur", () => {
  clearTimeout(typingClearTimer);
  setTyping(false);
});

els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.msgInput.value.trim();
  if (!text || !ACTIVE_CONVO) return;
  if (ACTIVE_CONVO_DATA?.status === "pending" && ACTIVE_CONVO_DATA.requestedBy !== CURRENT_USER.uid) {
    showToast("Accept this request before replying.");
    return;
  }
  els.msgInput.value = "";
  els.sendBtn.disabled = true;
  clearTimeout(typingClearTimer);
  setTyping(false);
  navigator.vibrate?.(8);

  const replyTo = REPLY_TARGET ? { ...REPLY_TARGET } : null;
  clearReplyTarget();

  try {
    await addDoc(collection(db, "conversations", ACTIVE_CONVO, "messages"), {
      senderId: CURRENT_USER.uid,
      text,
      status: "sent",
      reactions: {},
      ...(replyTo ? { replyTo } : {}),
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "conversations", ACTIVE_CONVO), {
      lastMessage: text,
      lastMessageAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("send failed:", err);
    showToast("Message failed to send.");
  } finally {
    els.sendBtn.disabled = false;
  }
});

els.msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.backBtn.addEventListener("click", () => {
  els.appShell.classList.remove("thread-open");
});

els.threadIdentity.addEventListener("click", () => {
  if (ACTIVE_OTHER) openProfile(ACTIVE_OTHER.uid);
});

/* ---------- Settings ---------- */
function currentTheme() {
  return localStorage.getItem("spoke-theme") || "dark";
}

function resolveTheme(t) {
  if (t === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return t;
}

function applyTheme(theme, opts = {}) {
  document.documentElement.setAttribute("data-theme", resolveTheme(theme));
  localStorage.setItem("spoke-theme", theme);
  updateThemeOptionUI(theme);
  if (opts.persist !== false && CURRENT_USER) {
    updateDoc(doc(db, "users", CURRENT_USER.uid), { "settings.theme": theme }).catch(() => {});
  }
}

function applySpokeField(on, opts = {}) {
  document.documentElement.classList.toggle("spoke-field-on", on);
  localStorage.setItem("spoke-field", on ? "on" : "off");
  if (els.toggleSpokeField) els.toggleSpokeField.checked = on;
  if (opts.persist !== false && CURRENT_USER) {
    updateDoc(doc(db, "users", CURRENT_USER.uid), { "settings.spokeField": on }).catch(() => {});
  }
}

function updateThemeOptionUI(theme) {
  if (!els.themeOptions) return;
  els.themeOptions.querySelectorAll(".theme-opt").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeChoice === theme);
  });
}

let systemThemeListenerAttached = false;
function watchSystemTheme() {
  if (systemThemeListenerAttached) return;
  systemThemeListenerAttached = true;
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "system") applyTheme("system", { persist: false });
  });
}

function initSettingsUI() {
  updateThemeOptionUI(currentTheme());
  watchSystemTheme();

  if (els.toggleSpokeField) els.toggleSpokeField.checked = localStorage.getItem("spoke-field") !== "off";

  const soundOn = localStorage.getItem("spoke-sound") !== "off";
  if (els.toggleSound) els.toggleSound.checked = soundOn;

  const desktopOn = localStorage.getItem("spoke-desktop-notif") === "on";
  if (els.toggleDesktopNotif) els.toggleDesktopNotif.checked = desktopOn;
}

if (els.settingsBtn) {
  els.settingsBtn.addEventListener("click", () => {
    els.settingsOverlay.classList.add("show");
  });
}
if (els.settingsClose) {
  els.settingsClose.addEventListener("click", () => closeSettings());
}
if (els.settingsOverlay) {
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.settingsOverlay?.classList.contains("show")) closeSettings();
});
function closeSettings() {
  els.settingsOverlay.classList.remove("show");
}

document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.settings-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
  });
});

if (els.themeOptions) {
  els.themeOptions.querySelectorAll(".theme-opt").forEach((opt) => {
    opt.addEventListener("click", () => applyTheme(opt.dataset.themeChoice));
  });
}

if (els.toggleSound) {
  els.toggleSound.addEventListener("change", () => {
    localStorage.setItem("spoke-sound", els.toggleSound.checked ? "on" : "off");
  });
}

if (els.toggleSpokeField) {
  els.toggleSpokeField.addEventListener("change", () => {
    applySpokeField(els.toggleSpokeField.checked);
  });
}

/* ---------- Account / password ---------- */
function initAccountUI() {
  const hasPasswordProvider = AUTH_USER?.providerData?.some((p) => p.providerId === "password");
  if (els.accountPasswordBlock) els.accountPasswordBlock.classList.toggle("hidden", !hasPasswordProvider);
  if (els.accountGoogleNote) els.accountGoogleNote.classList.toggle("hidden", !!hasPasswordProvider);
}

els.accountPasswordSave?.addEventListener("click", async () => {
  const errorEl = els.accountPasswordError;
  errorEl.textContent = "";

  const current = els.accountCurrentPassword.value;
  const next = els.accountNewPassword.value;
  const confirm = els.accountConfirmPassword.value;

  if (!current) return (errorEl.textContent = "Enter your current password.");
  if (next.length < 6) return (errorEl.textContent = "New password should be at least 6 characters.");
  if (next !== confirm) return (errorEl.textContent = "New passwords don't match.");

  const btn = els.accountPasswordSave;
  btn.disabled = true;
  btn.textContent = "Updating…";
  try {
    const credential = EmailAuthProvider.credential(AUTH_USER.email, current);
    await reauthenticateWithCredential(AUTH_USER, credential);
    await updatePassword(AUTH_USER, next);
    els.accountCurrentPassword.value = "";
    els.accountNewPassword.value = "";
    els.accountConfirmPassword.value = "";
    showToast("Password updated.");
  } catch (err) {
    console.error("password update failed:", err);
    const map = {
      "auth/wrong-password": "Your current password is incorrect.",
      "auth/invalid-credential": "Your current password is incorrect.",
      "auth/weak-password": "Choose a password with at least 6 characters.",
      "auth/requires-recent-login": "Please sign out and back in, then try again.",
      "auth/too-many-requests": "Too many attempts — try again later.",
    };
    errorEl.textContent = map[err.code] || "Couldn't update your password.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Update password";
  }
});

if (els.toggleDesktopNotif) {
  els.toggleDesktopNotif.addEventListener("change", async () => {
    if (els.toggleDesktopNotif.checked && Notification.permission !== "granted") {
      const perm = await Notification.requestPermission().catch(() => "denied");
      if (perm !== "granted") {
        els.toggleDesktopNotif.checked = false;
        showToast("Desktop notifications were blocked.");
        return;
      }
    }
    localStorage.setItem("spoke-desktop-notif", els.toggleDesktopNotif.checked ? "on" : "off");
  });
}

/* ---------- Profile ---------- */
async function openProfile(uid) {
  const isOwn = uid === CURRENT_USER.uid;
  let data;
  if (isOwn) {
    data = CURRENT_USER;
  } else {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      if (!snap.exists()) return showToast("User not found.");
      data = snap.data();
    } catch (err) {
      console.error("profile fetch failed:", err);
      return showToast("Couldn't load that profile.");
    }
  }
  renderProfileModal(uid, data, isOwn);
  els.profileOverlay.classList.add("show");
}

function renderProfileModal(uid, data, isOwn) {
  const statusOnline = data.status === "online";
  els.profileBody.innerHTML = `
    <div class="profile-avatar-wrap${isOwn ? " editable" : ""}" id="profile-avatar-wrap">
      <div class="avatar" id="profile-avatar">${avatarInner(data.displayName, data.photoURL)}</div>
      ${isOwn ? `<div class="avatar-edit-btn" id="profile-avatar-edit" title="Change photo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </div>` : ""}
    </div>
    ${isOwn
      ? `<input class="profile-name-input" id="profile-name-input" maxlength="40" value="${escapeHtml(data.displayName || "")}">`
      : `<div class="profile-name">${escapeHtml(data.displayName || "")}${verifiedBadge(data)}${data.role && data.role !== "member" ? `<span class="staff-pill">${data.role}</span>` : ""}</div>`}
    <div class="profile-username">@${escapeHtml(data.username || "")}</div>
    <div class="profile-status${statusOnline ? " online" : ""}">${statusOnline ? "Online" : "Offline"}</div>

    ${isOwn
      ? `<textarea class="profile-bio-input" id="profile-bio-input" maxlength="${MAX_BIO_LEN}" placeholder="Write a short bio…">${escapeHtml(data.bio || "")}</textarea>
         <div class="profile-charcount"><span id="profile-bio-count">${(data.bio || "").length}</span>/${MAX_BIO_LEN}</div>
         <div class="profile-actions">
           <button class="btn btn-primary" id="profile-save-btn" type="button" disabled>Save changes</button>
           <a class="btn btn-ghost" id="profile-fullpage-link" href="profile.html?uid=${encodeURIComponent(uid)}">See full profile</a>
         </div>
         <div class="profile-signout">
           <button class="btn btn-ghost" id="profile-signout-btn" type="button">Sign out</button>
         </div>`
      : `<div class="profile-bio">${data.bio ? escapeHtml(data.bio) : '<span style="color:var(--text-low);">No bio yet.</span>'}</div>
         <div class="profile-actions">
           <button class="btn btn-primary" id="profile-message-btn" type="button">Message</button>
           <a class="btn btn-ghost" id="profile-fullpage-link" href="profile.html?uid=${encodeURIComponent(uid)}">See full profile</a>
         </div>`}
  `;

  if (isOwn) {
    const nameInput = document.getElementById("profile-name-input");
    const bioInput = document.getElementById("profile-bio-input");
    const bioCount = document.getElementById("profile-bio-count");
    const saveBtn = document.getElementById("profile-save-btn");
    const avatarWrap = document.getElementById("profile-avatar-wrap");
    const signOutBtn = document.getElementById("profile-signout-btn");

    const markDirty = () => {
      bioCount.textContent = bioInput.value.length;
      const changed = nameInput.value.trim() !== (data.displayName || "") || bioInput.value !== (data.bio || "");
      saveBtn.disabled = !changed || nameInput.value.trim().length === 0;
    };
    nameInput.addEventListener("input", markDirty);
    bioInput.addEventListener("input", markDirty);

    saveBtn.addEventListener("click", async () => {
      const displayName = nameInput.value.trim();
      const bio = bioInput.value.trim();
      if (!displayName) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        await updateDoc(doc(db, "users", CURRENT_USER.uid), { displayName, bio });
        CURRENT_USER.displayName = displayName;
        CURRENT_USER.bio = bio;
        renderRailAvatar();
        showToast("Profile updated.");
        renderProfileModal(uid, CURRENT_USER, true);
      } catch (err) {
        console.error("profile save failed:", err);
        showToast("Couldn't save your profile.");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
      }
    });

    avatarWrap.addEventListener("click", () => els.avatarFileInput.click());
    signOutBtn.addEventListener("click", () => {
      closeProfile();
      if (confirm("Sign out of Spoke?")) els.signOutBtn.click();
    });
  } else {
    document.getElementById("profile-message-btn").addEventListener("click", () => {
      closeProfile();
      startConversationWith({ ...data, uid });
    });
  }
}

els.avatarFileInput.addEventListener("change", async () => {
  const file = els.avatarFileInput.files[0];
  els.avatarFileInput.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showToast("Please choose an image file.");
    return;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    showToast("That image is over the 20MB limit.");
    return;
  }

  const wrap = document.getElementById("profile-avatar-wrap");
  wrap?.classList.add("avatar-uploading");
  try {
    const url = await uploadAvatar(file);
    await updateDoc(doc(db, "users", CURRENT_USER.uid), { photoURL: url });
    CURRENT_USER.photoURL = url;
    renderRailAvatar();
    document.getElementById("profile-avatar").innerHTML = avatarInner(CURRENT_USER.displayName, url);
    showToast("Profile photo updated.");
  } catch (err) {
    console.error("avatar upload failed:", err);
    showToast(err.message || "Upload failed.");
  } finally {
    wrap?.classList.remove("avatar-uploading");
  }
});

async function uploadAvatar(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY_PRESET);
  form.append("folder", "spoke/avatars");
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("Cloudinary upload rejected:", json);
    throw new Error(json?.error?.message || "Upload failed — check your Cloudinary preset.");
  }
  return json.secure_url;
}

function closeProfile() {
  els.profileOverlay.classList.remove("show");
}
els.profileClose.addEventListener("click", closeProfile);
els.profileOverlay.addEventListener("click", (e) => {
  if (e.target === els.profileOverlay) closeProfile();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.profileOverlay.classList.contains("show")) closeProfile();
});

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
function formatTime(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDay(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
/* ---------- Mobile keyboard handling ---------- */
// iOS/Android push the on-screen keyboard up without resizing the layout
// viewport in older browsers, which leaves the composer hidden behind it.
// We track the *visual* viewport height in a CSS var so the app shell
// (and therefore the composer, which sits at the bottom of its flex
// column) always resizes to fit above the keyboard — the same behavior
// Instagram/Facebook use.
function setAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
}
setAppHeight();
window.visualViewport?.addEventListener("resize", setAppHeight);
window.visualViewport?.addEventListener("scroll", setAppHeight);
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", setAppHeight);
// Keep the newest message in view when the keyboard opens/closes while a
// thread is active, same as scrolling to bottom on send.
window.visualViewport?.addEventListener("resize", () => {
  if (ACTIVE_CONVO && document.activeElement === els.msgInput) {
    setTimeout(() => { els.threadScroll.scrollTop = els.threadScroll.scrollHeight; }, 60);
  }
});

/* ---------- Fixed-box chat layout ---------- */
// Instead of trusting flex/grid sizing to keep the message list from
// growing the page, we pin the header to the top and the bottom bar
// (banners + composer) to the bottom, then set the scroll area's own
// top/bottom to their measured pixel heights. The scroll area's height
// is then just "whatever's left" — a hard box CSS computes for us,
// nothing can expand it.
function fitThreadScroll() {
  if (!els.threadHead || !els.threadBottomBar || !els.threadScroll) return;
  const headH = els.threadHead.offsetHeight;
  const bottomH = els.threadBottomBar.offsetHeight;
  els.threadScroll.style.top = `${headH}px`;
  els.threadScroll.style.bottom = `${bottomH}px`;
}
if (els.threadHead && els.threadBottomBar) {
  const threadFitObserver = new ResizeObserver(() => fitThreadScroll());
  threadFitObserver.observe(els.threadHead);
  threadFitObserver.observe(els.threadBottomBar);
}
window.addEventListener("resize", fitThreadScroll);
window.visualViewport?.addEventListener("resize", fitThreadScroll);
fitThreadScroll();

let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3000);
}

/* =========================================================================
   Voice calls (1:1, audio-only) — WebRTC + Firestore signaling.
   Google's public STUN servers only for now (free, no signup). If a call
   fails to connect for some pairs of networks, that's the known gap a TURN
   server fills — add one to ICE_SERVERS below once you have credentials.
   ========================================================================= */
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // { urls: "turn:YOUR_TURN_HOST:3478", username: "...", credential: "..." },
];
const RING_TIMEOUT_MS = 30000; // auto-mark 'missed' if nobody answers

let callPC = null;            // active RTCPeerConnection
let callLocalStream = null;
let callId = null;            // active call doc id
let callRole = null;          // 'caller' | 'callee'
let callOtherUser = null;     // { uid, displayName, photoURL }
let unsubActiveCall = null;   // listens to the active call doc for status changes
let unsubRemoteCandidates = null;
let unsubIncomingCalls = null;
let incomingRingTimer = null;
let incomingVibrateTimer = null;
let ringTimeoutTimer = null;
let callMuted = false;

let callTimerInterval = null;
let callConnectedAt = null;
let audioCtx = null;
let audioMeterRAF = null;
let currentMicId = null;
let speakerOn = false;

const IS_LIKELY_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function listenForIncomingCalls() {
  if (!CURRENT_USER) return;
  const q = query(
    collection(db, "calls"),
    where("calleeUid", "==", CURRENT_USER.uid),
    where("status", "==", "ringing")
  );
  unsubIncomingCalls = onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      const data = change.doc.data();
      // Ignore anything stale (e.g. leftover from before this tab opened).
      const ageMs = data.createdAt ? Date.now() - data.createdAt.toMillis() : 0;
      if (ageMs > RING_TIMEOUT_MS) return;
      if (callId) return; // already on/ringing a different call — real multi-call handling is a later add
      showIncomingCall(change.doc.id, data);
    });
  }, (err) => console.error("incoming call listener:", err));
}

function showIncomingCall(id, data) {
  callId = id;
  callRole = "callee";
  callOtherUser = { uid: data.callerUid, displayName: data.callerName, photoURL: data.callerPhoto || null };

  els.callIncomingAvatar.innerHTML = avatarInner(data.callerName, data.callerPhoto);
  els.callIncomingName.textContent = data.callerName || "Unknown";
  els.callIncoming.classList.remove("hidden");

  // Vibrate in a repeating pattern (mobile / Android WebView) — a single
  // navigator.vibrate() call only fires once, so re-trigger it like a ringtone.
  navigator.vibrate?.([500, 300]);
  incomingVibrateTimer = setInterval(() => navigator.vibrate?.([500, 300]), 1600);

  if (document.hidden || !document.hasFocus()) {
    const desktopOn = localStorage.getItem("spoke-desktop-notif") === "on";
    if (desktopOn && Notification.permission === "granted") {
      const n = new Notification(`${data.callerName || "Someone"} is calling you`, {
        body: "Incoming voice call on Spoke",
        icon: "assets/spoke-mark.png",
        tag: `spoke-call-${id}`,
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }

  // Watch the call doc itself so we can auto-dismiss if the caller hangs up
  // or cancels before we answer.
  unsubActiveCall = onSnapshot(doc(db, "calls", id), (snap) => {
    const d = snap.data();
    if (!d || d.status !== "ringing") {
      hideIncomingCall();
      if (d && d.status === "ringing") return;
      if (callRole === "callee" && (!d || ["ended", "declined", "missed"].includes(d?.status))) {
        cleanupCall();
      }
    }
  });
}

function hideIncomingCall() {
  els.callIncoming.classList.add("hidden");
  clearInterval(incomingVibrateTimer);
  incomingVibrateTimer = null;
}

els.callDeclineBtn?.addEventListener("click", async () => {
  hideIncomingCall();
  if (callId) {
    await updateDoc(doc(db, "calls", callId), { status: "declined" }).catch(() => {});
  }
  cleanupCall();
});

els.callAcceptBtn?.addEventListener("click", async () => {
  hideIncomingCall();
  try {
    await answerCall();
  } catch (err) {
    console.error("accept call failed:", err);
    showToast(err.name === "NotAllowedError" ? "Microphone access was blocked." : "Couldn't join the call.");
    cleanupCall();
  }
});

/* ---------- Starting a call (caller side) ---------- */
els.callStartBtn?.addEventListener("click", async () => {
  if (!ACTIVE_CONVO || !ACTIVE_OTHER) return;
  if (callId) return showToast("You're already in a call.");
  try {
    await startCall();
  } catch (err) {
    console.error("start call failed:", err);
    showToast(err.name === "NotAllowedError" ? "Microphone access was blocked." : "Couldn't start the call.");
    cleanupCall();
  }
});

async function startCall() {
  callRole = "caller";
  callOtherUser = { ...ACTIVE_OTHER };

  callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  currentMicId = callLocalStream.getAudioTracks()[0]?.getSettings().deviceId || null;
  callPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  callLocalStream.getTracks().forEach((t) => callPC.addTrack(t, callLocalStream));
  callPC.ontrack = (e) => { els.callRemoteAudio.srcObject = e.streams[0]; setupAudioMeter(e.streams[0]); };

  const callDocRef = doc(collection(db, "calls"));
  callId = callDocRef.id;
  const callerCandidates = collection(db, "calls", callId, "callerCandidates");
  callPC.onicecandidate = (e) => {
    if (e.candidate) addDoc(callerCandidates, e.candidate.toJSON()).catch(() => {});
  };

  showCallScreen("Calling…");

  const offer = await callPC.createOffer();
  await callPC.setLocalDescription(offer);

  await setDoc(callDocRef, {
    convoId: ACTIVE_CONVO,
    callerUid: CURRENT_USER.uid,
    callerName: CURRENT_USER.displayName,
    callerPhoto: CURRENT_USER.photoURL || null,
    calleeUid: callOtherUser.uid,
    status: "ringing",
    offer: { type: offer.type, sdp: offer.sdp },
    createdAt: serverTimestamp(),
  });

  ringTimeoutTimer = setTimeout(async () => {
    if (callId && callRole === "caller") {
      await updateDoc(doc(db, "calls", callId), { status: "missed" }).catch(() => {});
      showToast("No answer.");
      cleanupCall();
    }
  }, RING_TIMEOUT_MS);

  // Watch for the callee's answer / a decline.
  unsubActiveCall = onSnapshot(callDocRef, async (snap) => {
    const d = snap.data();
    if (!d) return;
    if (d.status === "accepted" && d.answer && callPC && !callPC.currentRemoteDescription) {
      clearTimeout(ringTimeoutTimer);
      await callPC.setRemoteDescription(new RTCSessionDescription(d.answer));
      setCallScreenStatus("Connected"); startCallTimer();
    } else if (["declined", "ended", "missed"].includes(d.status)) {
      if (d.status === "declined") showToast(`${callOtherUser?.displayName || "They"} declined.`);
      cleanupCall();
    }
  });

  // Callee's ICE candidates arrive on their own subcollection.
  unsubRemoteCandidates = onSnapshot(
    collection(db, "calls", callId, "calleeCandidates"),
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "added" && callPC) {
          callPC.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
        }
      });
    }
  );
}

/* ---------- Answering a call (callee side) ---------- */
async function answerCall() {
  const callDocRef = doc(db, "calls", callId);
  const snap = await getDoc(callDocRef);
  const d = snap.data();
  if (!d || d.status !== "ringing") return cleanupCall();

  callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  currentMicId = callLocalStream.getAudioTracks()[0]?.getSettings().deviceId || null;
  callPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  callLocalStream.getTracks().forEach((t) => callPC.addTrack(t, callLocalStream));
  callPC.ontrack = (e) => { els.callRemoteAudio.srcObject = e.streams[0]; setupAudioMeter(e.streams[0]); };

  const calleeCandidates = collection(db, "calls", callId, "calleeCandidates");
  callPC.onicecandidate = (e) => {
    if (e.candidate) addDoc(calleeCandidates, e.candidate.toJSON()).catch(() => {});
  };

  showCallScreen("Connecting…");

  await callPC.setRemoteDescription(new RTCSessionDescription(d.offer));
  const answer = await callPC.createAnswer();
  await callPC.setLocalDescription(answer);

  await updateDoc(callDocRef, {
    status: "accepted",
    answer: { type: answer.type, sdp: answer.sdp },
  });
  setCallScreenStatus("Connected"); startCallTimer();

  // Re-attach the status watcher (the earlier one from showIncomingCall
  // already unsubscribed itself via hideIncomingCall's cleanup path).
  unsubActiveCall?.();
  unsubActiveCall = onSnapshot(callDocRef, (snap2) => {
    const d2 = snap2.data();
    if (!d2 || d2.status === "ended") cleanupCall();
  });

  unsubRemoteCandidates = onSnapshot(
    collection(db, "calls", callId, "callerCandidates"),
    (snap2) => {
      snap2.docChanges().forEach((change) => {
        if (change.type === "added" && callPC) {
          callPC.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
        }
      });
    }
  );
}

/* ---------- Call screen UI ---------- */
function showCallScreen(status) {
  els.callScreenAvatar.innerHTML = avatarInner(callOtherUser?.displayName, callOtherUser?.photoURL);
  els.callScreenName.textContent = callOtherUser?.displayName || "Unknown";
  setCallScreenStatus(status);
  els.callMuteBtn.classList.remove("active");
  callMuted = false;
  els.callScreenTimer.classList.add("hidden");
  els.callScreenTimer.textContent = "00:00";

  // Mic-picker is only meaningful where multiple input devices are common
  // (desktop). Speaker toggle only matters on a phone.
  els.callMicSelectBtn?.classList.toggle("hidden", IS_LIKELY_MOBILE);
  els.callSpeakerBtn?.classList.toggle("hidden", !IS_LIKELY_MOBILE);
  speakerOn = false;
  els.callSpeakerBtn?.classList.remove("active");

  els.callScreen.classList.remove("hidden");
}
function setCallScreenStatus(status) {
  els.callScreenStatus.textContent = status;
}

function startCallTimer() {
  if (callTimerInterval) return; // already running
  callConnectedAt = Date.now();
  els.callScreenTimer.classList.remove("hidden");
  els.callScreenTimer.textContent = "00:00";
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - callConnectedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    els.callScreenTimer.textContent = `${m}:${s}`;
  }, 1000);
}
function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callConnectedAt = null;
}

/* ---------- Audio-reactive avatar ring ---------- */
// Analyses the OTHER person's audio (the remote stream) so the glow behind
// their avatar grows while they're actually talking — a rough live "VU meter".
function setupAudioMeter(remoteStream) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(remoteStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length; // 0-255
      const level = Math.min(1, avg / 90); // rough normalize — talking voice rarely maxes this out
      if (els.callAvatarRing) {
        els.callAvatarRing.classList.toggle("speaking", level > 0.06);
        els.callAvatarRing.style.transform = `scale(${0.72 + level * 0.55})`;
      }
      audioMeterRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    console.error("audio meter setup failed:", err); // non-fatal — call still works without the visual
  }
}
function teardownAudioMeter() {
  cancelAnimationFrame(audioMeterRAF);
  audioMeterRAF = null;
  if (els.callAvatarRing) {
    els.callAvatarRing.classList.remove("speaking");
    els.callAvatarRing.style.transform = "";
  }
  audioCtx?.close().catch(() => {});
  audioCtx = null;
}

els.callMuteBtn?.addEventListener("click", () => {
  if (!callLocalStream) return;
  callMuted = !callMuted;
  callLocalStream.getAudioTracks().forEach((t) => (t.enabled = !callMuted));
  els.callMuteBtn.classList.toggle("active", callMuted);
});

/* ---------- Desktop: switch microphone mid-call ---------- */
els.callMicSelectBtn?.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!els.micMenu.classList.contains("hidden")) return closeMicMenu();
  await openMicMenu();
});
async function openMicMenu() {
  els.micMenu.innerHTML = `<div class="mic-menu-label">Loading microphones…</div>`;
  els.micMenu.classList.remove("hidden");
  positionMicMenu();

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    els.micMenu.innerHTML = `<div class="mic-menu-label">Microphone</div>` + mics.map((d, i) => `
      <button type="button" data-device-id="${escapeHtml(d.deviceId)}" class="${d.deviceId === currentMicId ? "active" : ""}">
        ${escapeHtml(d.label || `Microphone ${i + 1}`)}
      </button>
    `).join("");
    els.micMenu.querySelectorAll("button[data-device-id]").forEach((btn) => {
      btn.addEventListener("click", () => switchMic(btn.dataset.deviceId));
    });
  } catch (err) {
    els.micMenu.innerHTML = `<div class="mic-menu-label">Couldn't list microphones</div>`;
  }

  setTimeout(() => document.addEventListener("click", onOutsideMicMenuClick), 0);
}
function positionMicMenu() {
  const btnRect = els.callMicSelectBtn.getBoundingClientRect();
  const menuRect = els.micMenu.getBoundingClientRect();
  let left = btnRect.left + btnRect.width / 2 - menuRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  els.micMenu.style.left = `${left}px`;
  els.micMenu.style.top = `${btnRect.top - menuRect.height - 10}px`;
}
function onOutsideMicMenuClick(e) {
  if (!els.micMenu.contains(e.target) && e.target !== els.callMicSelectBtn) closeMicMenu();
}
function closeMicMenu() {
  els.micMenu.classList.add("hidden");
  document.removeEventListener("click", onOutsideMicMenuClick);
}
async function switchMic(deviceId) {
  closeMicMenu();
  if (!callPC || deviceId === currentMicId) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const newTrack = newStream.getAudioTracks()[0];
    const sender = callPC.getSenders().find((s) => s.track && s.track.kind === "audio");
    await sender?.replaceTrack(newTrack);
    callLocalStream?.getAudioTracks().forEach((t) => t.stop());
    callLocalStream = newStream;
    newTrack.enabled = !callMuted;
    currentMicId = deviceId;
    showToast("Microphone switched.");
  } catch (err) {
    console.error("mic switch failed:", err);
    showToast("Couldn't switch microphones.");
  }
}

/* ---------- Mobile: loudspeaker toggle ----------
   Real earpiece/speaker routing is an OS telephony feature the web
   platform doesn't expose — there's no standard API to force a phone's
   earpiece on or off from a webpage or WebView. Where the browser DOES
   support HTMLMediaElement.setSinkId (routing playback to a specific
   output device), this switches between whatever counts as the default
   vs. an explicit speaker/speakerphone device on that device. Where it's
   unsupported, the button is a no-op — most mobile browsers already play
   WebRTC audio through the loudspeaker by default, unlike a native phone
   call which defaults to the earpiece, so this mainly matters on devices
   where that's not already the case. */
els.callSpeakerBtn?.addEventListener("click", async () => {
  if (!("setSinkId" in HTMLMediaElement.prototype)) {
    showToast("Your browser plays calls on speaker by default already.");
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    const speakerDevice = outputs.find((d) => /speaker/i.test(d.label));
    speakerOn = !speakerOn;
    const targetId = speakerOn && speakerDevice ? speakerDevice.deviceId : "default";
    await els.callRemoteAudio.setSinkId(targetId);
    els.callSpeakerBtn.classList.toggle("active", speakerOn);
  } catch (err) {
    console.error("speaker toggle failed:", err);
    showToast("Couldn't switch audio output on this device.");
  }
});

els.callHangupBtn?.addEventListener("click", async () => {
  if (callId) {
    await updateDoc(doc(db, "calls", callId), { status: "ended" }).catch(() => {});
  }
  cleanupCall();
});

function cleanupCall() {
  clearTimeout(ringTimeoutTimer);
  hideIncomingCall();
  closeMicMenu();
  stopCallTimer();
  teardownAudioMeter();
  els.callScreen.classList.add("hidden");
  els.callRemoteAudio.srcObject = null;

  callPC?.close();
  callPC = null;
  callLocalStream?.getTracks().forEach((t) => t.stop());
  callLocalStream = null;
  unsubActiveCall?.();
  unsubActiveCall = null;
  unsubRemoteCandidates?.();
  unsubRemoteCandidates = null;
  callId = null;
  callRole = null;
  callOtherUser = null;
  callMuted = false;
  currentMicId = null;
}
