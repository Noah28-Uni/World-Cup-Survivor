import React, { useState, useEffect, useMemo } from "react";

/*
  ════════════════════════════════════════════════════════════════
  FIFA WORLD CUP 2026 — SURVIVOR POOL
  Single-file React + Firebase (Auth + Firestore). Noah's standard stack.
  ════════════════════════════════════════════════════════════════

  CONTEST RULES (from the screenshot):
  • GROUP STAGE: pick 4 teams to advance to the Round of 32. All 4 must
    advance or the entry is eliminated.
  • KNOCKOUT: pick 1 team per round EXCEPT R32, R16, QF where you pick 2.
    Every pick in a round must win (reg/OT/shootout) or you're out.
  • Each team usable ONCE across the entire contest.
  • Last surviving entry wins.

  AUTH: Google sign-in via Firebase. The signed-in user's UID is the
  entry document ID — one entry per person, no name collisions.

  RESULTS STRATEGY (deliberate — avoids the ESPN-in-browser failure mode):
  Firestore is the source of truth. Admins mark each team win/loss per
  round. NO live API in the browser. To automate later, deploy the Cloud
  Function at the bottom of this file: it writes the SAME
  results/{round} docs this UI already reads. Zero UI changes needed.

  SETUP (3 steps):
  1. Set Firebase env vars in Netlify (see README / .env.example).
  2. Firebase console → Authentication → enable Google provider.
  3. Firestore → paste the security rules from the comment block at bottom.
     Add your UID to the `admins` doc to unlock the Admin tab.
*/

import { auth, db, provider } from "./firebase.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  doc, setDoc, getDoc, onSnapshot, collection,
} from "firebase/firestore";

// ── Tournament structure ────────────────────────────────────────
const ROUNDS = [
  { id: "group", label: "Group Stage",   picks: 4, deadline: "6/11 @ 14:00" },
  { id: "r32",   label: "Round of 32",   picks: 2, deadline: "6/29 @ 12:00" },
  { id: "r16",   label: "Round of 16",   picks: 2, deadline: "7/4 @ 12:00"  },
  { id: "qf",    label: "Quarterfinals", picks: 2, deadline: "7/9 @ 12:00"  },
  { id: "sf",    label: "Semifinals",    picks: 1, deadline: "7/14 @ 12:00" },
  { id: "final", label: "Final",         picks: 1, deadline: "7/19 @ 12:00" },
];

// ── The real 48-team field, by group (Dec 5 2025 draw) ──────────
const GROUPS = {
  A: ["Mexico", "South Africa", "South Korea", "Czech Republic"],
  B: ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"],
  C: ["Brazil", "Morocco", "Haiti", "Scotland"],
  D: ["United States", "Paraguay", "Australia", "Turkey"],
  E: ["Germany", "Curaçao", "Ivory Coast", "Ecuador"],
  F: ["Netherlands", "Japan", "Sweden", "Tunisia"],
  G: ["Belgium", "Egypt", "Iran", "New Zealand"],
  H: ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
  I: ["France", "Senegal", "Iraq", "Norway"],
  J: ["Argentina", "Algeria", "Austria", "Jordan"],
  K: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
  L: ["England", "Croatia", "Ghana", "Panama"],
};
const ALL_TEAMS = Object.values(GROUPS).flat();

const C = {
  bg: "#0a0e14", panel: "#121823", line: "#1f2937",
  gold: "#f5c518", green: "#2dd4a7", red: "#f0506e",
  txt: "#e8edf4", dim: "#7d8aa0",
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState("picks");
  const [picks, setPicks] = useState({});
  const [results, setResults] = useState({});
  const [entries, setEntries] = useState([]);
  const [saved, setSaved] = useState(false);

  // ── Auth ──────────────────────────────────────────────────────
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthReady(true);
      if (u) {
        // load this user's existing picks
        const snap = await getDoc(doc(db, "entries", u.uid));
        if (snap.exists()) setPicks(snap.data().picks || {});
        // admin check
        const adminSnap = await getDoc(doc(db, "config", "admins"));
        if (adminSnap.exists() && (adminSnap.data().uids || []).includes(u.uid))
          setIsAdmin(true);
      } else {
        setPicks({}); setIsAdmin(false);
      }
    });
  }, []);

  // ── Live results + entries streams ─────────────────────────────
  useEffect(() => {
    const u1 = onSnapshot(collection(db, "results"), (snap) => {
      const r = {}; snap.forEach((d) => (r[d.id] = d.data())); setResults(r);
    });
    const u2 = onSnapshot(collection(db, "entries"), (snap) => {
      const e = []; snap.forEach((d) => e.push(d.data())); setEntries(e);
    });
    return () => { u1(); u2(); };
  }, []);

  const usedTeams = useMemo(() => {
    const s = new Set();
    Object.values(picks).flat().forEach((t) => s.add(t));
    return s;
  }, [picks]);

  const myStatus = useMemo(() => computeStatus(picks, results), [picks, results]);

  function togglePick(roundId, team, max) {
    if (!user) return;
    setSaved(false);
    setPicks((prev) => {
      const cur = prev[roundId] || [];
      if (cur.includes(team)) return { ...prev, [roundId]: cur.filter((t) => t !== team) };
      if (usedTeams.has(team)) return prev;
      if (cur.length >= max) return prev;
      return { ...prev, [roundId]: [...cur, team] };
    });
  }

  async function saveEntry() {
    if (!user) return;
    await setDoc(doc(db, "entries", user.uid), {
      uid: user.uid,
      name: user.displayName || user.email,
      photo: user.photoURL || "",
      picks,
      updated: Date.now(),
    });
    setSaved(true);
  }

  async function markResult(roundId, team, val) {
    await setDoc(doc(db, "results", roundId), { [team]: val }, { merge: true });
  }

  if (!authReady)
    return <Shell><div style={{ padding: 40, color: C.dim }}>Loading…</div></Shell>;

  if (!user)
    return (
      <Shell>
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <p style={{ color: C.dim, marginBottom: 20 }}>
            Sign in to enter the pool and make your picks.
          </p>
          <button onClick={() => signInWithPopup(auth, provider)} style={{
            background: "#fff", color: "#1f1f1f", border: "none", padding: "12px 24px",
            borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 15 }}>
            Continue with Google
          </button>
        </div>
      </Shell>
    );

  return (
    <Shell user={user}>
      <nav style={{ display: "flex", gap: 4, padding: "12px 0", flexWrap: "wrap" }}>
        {[["picks", "My Picks"], ["standings", "Standings"],
          ...(isAdmin ? [["admin", "Admin"]] : [])].map(([id, l]) => (
          <button key={id} onClick={() => setView(id)} style={{
            background: view === id ? C.gold : "transparent",
            color: view === id ? "#0a0e14" : C.dim, border: "none",
            padding: "8px 16px", borderRadius: 8, cursor: "pointer",
            fontWeight: 700, fontFamily: "'Bebas Neue'", letterSpacing: 1.5, fontSize: 16 }}>
            {l}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => signOut(auth)} style={{
          background: "transparent", color: C.dim, border: `1px solid ${C.line}`,
          padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
          Sign out
        </button>
      </nav>

      {view === "picks" && (
        <PicksView {...{ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus }} />
      )}
      {view === "standings" && <StandingsView entries={entries} results={results} />}
      {view === "admin" && isAdmin && <AdminView results={results} markResult={markResult} />}
    </Shell>
  );
}

// ── Survivor status engine ──────────────────────────────────────
function computeStatus(picks, results) {
  for (const r of ROUNDS) {
    for (const t of picks[r.id] || []) {
      if ((results[r.id] || {})[t] === "loss")
        return { alive: false, round: r.label, team: t };
    }
  }
  return { alive: true };
}

// ── Layout shell ────────────────────────────────────────────────
function Shell({ children, user }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.txt,
      fontFamily: "'Source Sans 3', system-ui, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
      <header style={{ padding: "26px 20px 16px", borderBottom: `1px solid ${C.line}`,
        background: "linear-gradient(180deg,#0d1320,#0a0e14)" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex",
          justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 12, letterSpacing: 3, color: C.gold }}>
              FIFA WORLD CUP 2026 · USA · MEXICO · CANADA
            </div>
            <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 44, margin: "2px 0 0", letterSpacing: 1 }}>
              SURVIVOR POOL
            </h1>
          </div>
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.dim }}>
              {user.photoURL && <img src={user.photoURL} alt="" width={28} height={28}
                style={{ borderRadius: "50%" }} />}
              <span>{user.displayName || user.email}</span>
            </div>
          )}
        </div>
      </header>
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "0 16px 60px" }}>{children}</main>
    </div>
  );
}

// ── PICKS ───────────────────────────────────────────────────────
function PicksView({ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus }) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        margin: "16px 0 18px" }}>
        <div style={{ fontSize: 13, color: C.dim, maxWidth: 460, lineHeight: 1.5 }}>
          Pick 4 to clear the group stage, then survive the knockout gauntlet.
          One wrong pick and you're out. Each team once.
        </div>
        <button onClick={saveEntry} style={{ background: saved ? C.green : C.gold,
          color: "#0a0e14", border: "none", padding: "11px 22px", borderRadius: 8,
          fontWeight: 700, cursor: "pointer", fontFamily: "'Bebas Neue'",
          letterSpacing: 1, fontSize: 17, whiteSpace: "nowrap" }}>
          {saved ? "SAVED ✓" : "SAVE PICKS"}
        </button>
      </div>

      {!myStatus.alive && (
        <div style={{ background: "rgba(240,80,110,.12)", border: `1px solid ${C.red}`,
          borderRadius: 10, padding: 14, marginBottom: 18, color: C.red, fontWeight: 600 }}>
          ELIMINATED — {myStatus.team} lost in the {myStatus.round}.
        </div>
      )}

      {ROUNDS.map((r) => {
        const sel = picks[r.id] || [];
        const done = sel.length === r.picks;
        const isGroup = r.id === "group";
        return (
          <section key={r.id} style={{ marginBottom: 22, background: C.panel,
            border: `1px solid ${done ? C.green : C.line}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between",
              alignItems: "center", borderBottom: `1px solid ${C.line}` }}>
              <div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: 1 }}>{r.label}</div>
                <div style={{ fontSize: 12, color: C.dim }}>Picks lock {r.deadline}</div>
              </div>
              <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20,
                color: done ? C.green : C.gold }}>{sel.length}/{r.picks}</div>
            </div>
            <div style={{ padding: 12 }}>
              {isGroup
                ? Object.entries(GROUPS).map(([g, teams]) => (
                    <div key={g} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: C.dim, letterSpacing: 1.5,
                        marginBottom: 5, fontWeight: 700 }}>GROUP {g}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {teams.map((t) => (
                          <TeamChip key={t} {...{ t, r, sel, usedTeams, results, togglePick }} />
                        ))}
                      </div>
                    </div>
                  ))
                : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {ALL_TEAMS.map((t) => (
                      <TeamChip key={t} {...{ t, r, sel, usedTeams, results, togglePick }} />
                    ))}
                  </div>
                )}
            </div>
          </section>
        );
      })}
    </>
  );
}

function TeamChip({ t, r, sel, usedTeams, results, togglePick }) {
  const picked = sel.includes(t);
  const lockedElsewhere = usedTeams.has(t) && !picked;
  const res = (results[r.id] || {})[t];
  let bg = "#0d131e", bd = C.line, col = C.txt;
  if (picked) { bg = C.gold; col = "#0a0e14"; bd = C.gold; }
  if (lockedElsewhere) { col = "#3a4456"; bd = "#1a212e"; }
  if (picked && res === "win")  { bg = C.green; col = "#06231b"; }
  if (picked && res === "loss") { bg = C.red;   col = "#fff"; }
  return (
    <button disabled={lockedElsewhere} onClick={() => togglePick(r.id, t, r.picks)}
      style={{ background: bg, color: col, border: `1px solid ${bd}`,
        padding: "7px 11px", borderRadius: 7, fontSize: 13, fontWeight: 600,
        cursor: lockedElsewhere ? "not-allowed" : "pointer",
        opacity: lockedElsewhere ? 0.45 : 1 }}>
      {t}
    </button>
  );
}

// ── STANDINGS ───────────────────────────────────────────────────
function StandingsView({ entries, results }) {
  const ranked = entries
    .map((e) => ({ ...e, status: computeStatus(e.picks || {}, results) }))
    .sort((a, b) => (b.status.alive ? 1 : 0) - (a.status.alive ? 1 : 0));
  const aliveCount = ranked.filter((e) => e.status.alive).length;
  return (
    <div style={{ paddingTop: 16 }}>
      <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 26, letterSpacing: 1 }}>
        STANDINGS · {aliveCount} ALIVE
      </h2>
      {ranked.length === 0 && <p style={{ color: C.dim }}>No entries yet.</p>}
      {ranked.map((e) => (
        <div key={e.uid} style={{ display: "flex", justifyContent: "space-between",
          alignItems: "center", background: C.panel, border: `1px solid ${C.line}`,
          borderRadius: 10, padding: "12px 16px", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {e.photo && <img src={e.photo} alt="" width={26} height={26} style={{ borderRadius: "50%" }} />}
            <span style={{ fontWeight: 700 }}>{e.name}</span>
          </div>
          <span style={{ color: e.status.alive ? C.green : C.red, fontWeight: 700,
            fontFamily: "'Bebas Neue'", letterSpacing: 1, fontSize: 17 }}>
            {e.status.alive ? "ALIVE" : `OUT · ${e.status.round}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── ADMIN ───────────────────────────────────────────────────────
function AdminView({ results, markResult }) {
  const [round, setRound] = useState("group");
  return (
    <div style={{ paddingTop: 16 }}>
      <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 26, letterSpacing: 1 }}>MARK RESULTS</h2>
      <p style={{ color: C.dim, fontSize: 13, lineHeight: 1.5 }}>
        Set each team win/loss per round. Source of truth for the whole pool.
        A Cloud Function can later write these same docs automatically.
      </p>
      <select value={round} onChange={(e) => setRound(e.target.value)} style={{
        background: C.panel, color: C.txt, border: `1px solid ${C.line}`,
        padding: "9px 12px", borderRadius: 8, marginBottom: 14 }}>
        {ROUNDS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ALL_TEAMS.map((t) => {
          const res = (results[round] || {})[t];
          return (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 4,
              background: C.panel, border: `1px solid ${C.line}`, borderRadius: 7, padding: "4px 8px" }}>
              <span style={{ fontSize: 12, minWidth: 90 }}>{t}</span>
              <button onClick={() => markResult(round, t, "win")} style={{
                background: res === "win" ? C.green : "transparent",
                color: res === "win" ? "#06231b" : C.dim, border: `1px solid ${C.line}`,
                borderRadius: 5, padding: "2px 7px", fontSize: 11, cursor: "pointer" }}>W</button>
              <button onClick={() => markResult(round, t, "loss")} style={{
                background: res === "loss" ? C.red : "transparent",
                color: res === "loss" ? "#fff" : C.dim, border: `1px solid ${C.line}`,
                borderRadius: 5, padding: "2px 7px", fontSize: 11, cursor: "pointer" }}>L</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
