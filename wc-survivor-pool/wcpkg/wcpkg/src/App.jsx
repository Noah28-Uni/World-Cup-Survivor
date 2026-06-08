import React, { useState, useEffect, useMemo } from "react";
import { auth, db, provider } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, getDoc, onSnapshot, collection } from "firebase/firestore";

/*
  FIFA WORLD CUP 2026 — SURVIVOR POOL
  React + Firebase (Google Auth + Firestore).
  Group Stage: pick 4 to advance. Knockout: 1/round except R32,R16,QF (pick 2).
  Each pick must win or you're out. Each team once. Last entry alive wins.
  Results: admins mark win/loss per round in the Admin tab (source of truth).
*/

const ROUNDS = [
  { id: "group", label: "Group Stage",   picks: 4, deadline: "6/11 @ 14:00" },
  { id: "r32",   label: "Round of 32",   picks: 2, deadline: "6/29 @ 12:00" },
  { id: "r16",   label: "Round of 16",   picks: 2, deadline: "7/4 @ 12:00"  },
  { id: "qf",    label: "Quarterfinals", picks: 2, deadline: "7/9 @ 12:00"  },
  { id: "sf",    label: "Semifinals",    picks: 1, deadline: "7/14 @ 12:00" },
  { id: "final", label: "Final",         picks: 1, deadline: "7/19 @ 12:00" },
];

// 48-team field by group (Dec 5 2025 draw) with flag emojis
const GROUPS = {
  A: [["Mexico","🇲🇽"],["South Africa","🇿🇦"],["South Korea","🇰🇷"],["Czech Republic","🇨🇿"]],
  B: [["Canada","🇨🇦"],["Bosnia and Herzegovina","🇧🇦"],["Qatar","🇶🇦"],["Switzerland","🇨🇭"]],
  C: [["Brazil","🇧🇷"],["Morocco","🇲🇦"],["Haiti","🇭🇹"],["Scotland","🏴󠁧󠁢󠁳󠁣󠁴󠁿"]],
  D: [["United States","🇺🇸"],["Paraguay","🇵🇾"],["Australia","🇦🇺"],["Turkey","🇹🇷"]],
  E: [["Germany","🇩🇪"],["Curaçao","🇨🇼"],["Ivory Coast","🇨🇮"],["Ecuador","🇪🇨"]],
  F: [["Netherlands","🇳🇱"],["Japan","🇯🇵"],["Sweden","🇸🇪"],["Tunisia","🇹🇳"]],
  G: [["Belgium","🇧🇪"],["Egypt","🇪🇬"],["Iran","🇮🇷"],["New Zealand","🇳🇿"]],
  H: [["Spain","🇪🇸"],["Cape Verde","🇨🇻"],["Saudi Arabia","🇸🇦"],["Uruguay","🇺🇾"]],
  I: [["France","🇫🇷"],["Senegal","🇸🇳"],["Iraq","🇮🇶"],["Norway","🇳🇴"]],
  J: [["Argentina","🇦🇷"],["Algeria","🇩🇿"],["Austria","🇦🇹"],["Jordan","🇯🇴"]],
  K: [["Portugal","🇵🇹"],["DR Congo","🇨🇩"],["Uzbekistan","🇺🇿"],["Colombia","🇨🇴"]],
  L: [["England","🏴󠁧󠁢󠁥󠁮󠁧󠁿"],["Croatia","🇭🇷"],["Ghana","🇬🇭"],["Panama","🇵🇦"]],
};
const FLAG = {};
Object.values(GROUPS).flat().forEach(([n, f]) => (FLAG[n] = f));
const ALL_TEAMS = Object.values(GROUPS).flat().map(([n]) => n);

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminConfigured, setAdminConfigured] = useState(true);
  const [view, setView] = useState("picks");
  const [picks, setPicks] = useState({});
  const [results, setResults] = useState({});
  const [entries, setEntries] = useState([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u); setAuthReady(true);
      if (u) {
        const snap = await getDoc(doc(db, "entries", u.uid));
        if (snap.exists()) setPicks(snap.data().picks || {});
        const adminSnap = await getDoc(doc(db, "config", "admins"));
        setAdminConfigured(adminSnap.exists());
        if (adminSnap.exists() && (adminSnap.data().uids || []).includes(u.uid)) setIsAdmin(true);
      } else { setPicks({}); setIsAdmin(false); }
    });
  }, []);

  useEffect(() => {
    const u1 = onSnapshot(collection(db, "results"), (s) => {
      const r = {}; s.forEach((d) => (r[d.id] = d.data())); setResults(r);
    });
    const u2 = onSnapshot(collection(db, "entries"), (s) => {
      const e = []; s.forEach((d) => e.push(d.data())); setEntries(e);
    });
    return () => { u1(); u2(); };
  }, []);

  const usedTeams = useMemo(() => {
    const s = new Set(); Object.values(picks).flat().forEach((t) => s.add(t)); return s;
  }, [picks]);
  const myStatus = useMemo(() => computeStatus(picks, results), [picks, results]);

  function togglePick(roundId, team, max) {
    if (!user) return; setSaved(false);
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
      uid: user.uid, name: user.displayName || user.email,
      photo: user.photoURL || "", picks, updated: Date.now(),
    });
    setSaved(true);
  }
  async function markResult(roundId, team, val) {
    await setDoc(doc(db, "results", roundId), { [team]: val }, { merge: true });
  }

  return (
    <>
      <Style />
      {!authReady ? (
        <div className="wc-boot"><div className="wc-ball" />LOADING</div>
      ) : !user ? (
        <Landing onLogin={() => signInWithPopup(auth, provider)} />
      ) : (
        <div className="wc-app">
          <TopBar user={user} view={view} setView={setView} isAdmin={isAdmin}
            adminConfigured={adminConfigured} onSignOut={() => signOut(auth)} />
          <main className="wc-main">
            {view === "picks" && (
              <Picks {...{ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus }} />
            )}
            {view === "standings" && <Standings entries={entries} results={results} />}
            {view === "admin" && isAdmin && <Admin results={results} markResult={markResult} />}
            {view === "setup" && <Setup uid={user.uid} />}
          </main>
        </div>
      )}
    </>
  );
}

function computeStatus(picks, results) {
  for (const r of ROUNDS)
    for (const t of picks[r.id] || [])
      if ((results[r.id] || {})[t] === "loss")
        return { alive: false, round: r.label, team: t };
  return { alive: true };
}

// ── LANDING / LOGIN ─────────────────────────────────────────────
function Landing({ onLogin }) {
  return (
    <div className="wc-landing">
      <div className="wc-pitch" />
      <div className="wc-glow wc-glow-1" />
      <div className="wc-glow wc-glow-2" />
      <div className="wc-glow wc-glow-3" />
      <div className="wc-landing-inner">
        <div className="wc-kicker wc-fade" style={{ animationDelay: ".05s" }}>
          FIFA WORLD CUP 26 · USA · MEXICO · CANADA
        </div>
        <h1 className="wc-hero wc-fade" style={{ animationDelay: ".15s" }}>
          SURVIVOR<span className="wc-hero-amp">×</span>POOL
        </h1>
        <p className="wc-sub wc-fade" style={{ animationDelay: ".3s" }}>
          Pick four to escape the group stage. Then survive the knockout gauntlet —
          one wrong call and you're out. Every team, once. Last one standing takes it all.
        </p>
        <button className="wc-google wc-fade" style={{ animationDelay: ".45s" }} onClick={onLogin}>
          <GoogleIcon /> Continue with Google
        </button>
        <div className="wc-flagstrip wc-fade" style={{ animationDelay: ".6s" }}>
          {["🇦🇷","🇧🇷","🇫🇷","🇪🇸","🏴󠁧󠁢󠁥󠁮󠁧󠁿","🇩🇪","🇵🇹","🇳🇱","🇺🇸","🇲🇽","🇯🇵","🇲🇦"].map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── TOP BAR ─────────────────────────────────────────────────────
function TopBar({ user, view, setView, isAdmin, adminConfigured, onSignOut }) {
  const tabs = [["picks", "My Picks"], ["standings", "Standings"],
    ...(isAdmin ? [["admin", "Admin"]] : []),
    ...(!adminConfigured ? [["setup", "⚙ Setup"]] : [])];
  return (
    <header className="wc-top">
      <div className="wc-top-inner">
        <div className="wc-brand">
          <span className="wc-trophy">🏆</span>
          <div>
            <div className="wc-brand-sm">WORLD CUP 26</div>
            <div className="wc-brand-lg">SURVIVOR POOL</div>
          </div>
        </div>
        <nav className="wc-nav">
          {tabs.map(([id, l]) => (
            <button key={id} className={"wc-tab" + (view === id ? " on" : "")}
              onClick={() => setView(id)}>{l}</button>
          ))}
        </nav>
        <div className="wc-user">
          {user.photoURL && <img src={user.photoURL} alt="" />}
          <span className="wc-user-name">{(user.displayName || user.email).split(" ")[0]}</span>
          <button className="wc-out" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

// ── PICKS ───────────────────────────────────────────────────────
function Picks({ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus }) {
  return (
    <div className="wc-picks">
      <div className="wc-picks-head wc-fade">
        <div>
          <h2 className="wc-h2">Your Bracket</h2>
          <p className="wc-muted">Lock in each round. Greyed teams are already used elsewhere.</p>
        </div>
        <button className={"wc-save" + (saved ? " done" : "")} onClick={saveEntry}>
          {saved ? "✓ Saved" : "Save Picks"}
        </button>
      </div>

      {!myStatus.alive && (
        <div className="wc-dead wc-fade">
          <strong>ELIMINATED</strong> — {FLAG[myStatus.team]} {myStatus.team} lost in the {myStatus.round}.
        </div>
      )}

      {ROUNDS.map((r, i) => {
        const sel = picks[r.id] || [];
        const done = sel.length === r.picks;
        return (
          <section key={r.id} className={"wc-round wc-fade" + (done ? " done" : "")}
            style={{ animationDelay: `${0.05 * i}s` }}>
            <div className="wc-round-head">
              <div className="wc-round-title">
                <span className="wc-round-name">{r.label}</span>
                <span className="wc-round-lock">Locks {r.deadline}</span>
              </div>
              <div className={"wc-count" + (done ? " done" : "")}>{sel.length}/{r.picks}</div>
            </div>
            <div className="wc-round-body">
              {r.id === "group"
                ? Object.entries(GROUPS).map(([g, teams]) => (
                    <div key={g} className="wc-group">
                      <div className="wc-group-tag">GROUP {g}</div>
                      <div className="wc-chips">
                        {teams.map(([t]) => (
                          <Chip key={t} {...{ t, r, sel, usedTeams, results, togglePick }} />
                        ))}
                      </div>
                    </div>
                  ))
                : <div className="wc-chips">
                    {ALL_TEAMS.map((t) => (
                      <Chip key={t} {...{ t, r, sel, usedTeams, results, togglePick }} />
                    ))}
                  </div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Chip({ t, r, sel, usedTeams, results, togglePick }) {
  const picked = sel.includes(t);
  const locked = usedTeams.has(t) && !picked;
  const res = (results[r.id] || {})[t];
  let cls = "wc-chip";
  if (picked) cls += " picked";
  if (locked) cls += " locked";
  if (picked && res === "win") cls += " win";
  if (picked && res === "loss") cls += " loss";
  return (
    <button className={cls} disabled={locked} onClick={() => togglePick(r.id, t, r.picks)}>
      <span className="wc-chip-flag">{FLAG[t]}</span>{t}
      {picked && res === "win" && <span className="wc-chip-mark">✓</span>}
      {picked && res === "loss" && <span className="wc-chip-mark">✕</span>}
    </button>
  );
}

// ── STANDINGS ───────────────────────────────────────────────────
function Standings({ entries, results }) {
  const ranked = entries
    .map((e) => ({ ...e, status: computeStatus(e.picks || {}, results) }))
    .sort((a, b) => (b.status.alive ? 1 : 0) - (a.status.alive ? 1 : 0));
  const alive = ranked.filter((e) => e.status.alive).length;
  return (
    <div className="wc-stand wc-fade">
      <div className="wc-stand-head">
        <h2 className="wc-h2">Standings</h2>
        <div className="wc-alive-pill">{alive} ALIVE · {ranked.length} ENTRIES</div>
      </div>
      {ranked.length === 0 && <p className="wc-muted">No entries yet. Be the first.</p>}
      {ranked.map((e, i) => (
        <div key={e.uid} className={"wc-entry" + (e.status.alive ? "" : " out")}>
          <span className="wc-entry-rank">{i + 1}</span>
          {e.photo && <img src={e.photo} alt="" className="wc-entry-pic" />}
          <span className="wc-entry-name">{e.name}</span>
          <span className={"wc-entry-stat" + (e.status.alive ? " alive" : "")}>
            {e.status.alive ? "ALIVE" : `OUT · ${e.status.round}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── ADMIN ───────────────────────────────────────────────────────
function Admin({ results, markResult }) {
  const [round, setRound] = useState("group");
  return (
    <div className="wc-admin wc-fade">
      <h2 className="wc-h2">Mark Results</h2>
      <p className="wc-muted">Set win/loss per round. Source of truth for the whole pool.</p>
      <div className="wc-admin-rounds">
        {ROUNDS.map((r) => (
          <button key={r.id} className={"wc-rtab" + (round === r.id ? " on" : "")}
            onClick={() => setRound(r.id)}>{r.label}</button>
        ))}
      </div>
      <div className="wc-admin-grid">
        {ALL_TEAMS.map((t) => {
          const res = (results[round] || {})[t];
          return (
            <div key={t} className="wc-admin-row">
              <span className="wc-admin-team">{FLAG[t]} {t}</span>
              <div className="wc-admin-btns">
                <button className={"wc-wl w" + (res === "win" ? " on" : "")}
                  onClick={() => markResult(round, t, "win")}>W</button>
                <button className={"wc-wl l" + (res === "loss" ? " on" : "")}
                  onClick={() => markResult(round, t, "loss")}>L</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Setup({ uid }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(uid).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="wc-setup wc-fade">
      <h2 className="wc-h2">One-Time Admin Setup</h2>
      <p className="wc-muted">
        No admin exists yet. Make yourself admin so you can mark results.
        This only needs to be done once.
      </p>
      <div className="wc-setup-uid">
        <div>
          <div className="wc-setup-label">YOUR USER ID</div>
          <code className="wc-setup-code">{uid}</code>
        </div>
        <button className="wc-copy" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <ol className="wc-steps">
        <li>Open <strong>Firebase Console → Firestore Database</strong>.</li>
        <li>Click <strong>Start collection</strong> → Collection ID: <code>config</code>.</li>
        <li>Document ID: <code>admins</code>.</li>
        <li>Add field: name <code>uids</code>, type <strong>array</strong>.</li>
        <li>Add one array item (type <strong>string</strong>) = your copied ID above.</li>
        <li><strong>Save</strong>, then refresh this page. The Admin tab appears.</li>
      </ol>
      <p className="wc-muted">
        To add more admins later, just add their User IDs to that same <code>uids</code> array.
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16.5z"/>
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.7l7.9-6.1z"/>
      <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.4-4.6 2.2-7.9 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/>
    </svg>
  );
}

// ── STYLES ──────────────────────────────────────────────────────
function Style() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Source+Sans+3:wght@400;500;600;700;800&display=swap');
:root{
  --navy:#0a0e1a; --navy2:#0f1626; --panel:#141d30; --panel2:#1a2740;
  --line:#243349; --txt:#eef3fb; --dim:#8194b0;
  --pink:#ff2d78; --teal:#19e6c8; --blue:#2b7fff; --gold:#ffc93c;
  --grad:linear-gradient(135deg,var(--pink),var(--blue) 55%,var(--teal));
}
*{box-sizing:border-box}
body{margin:0}
.wc-app,.wc-landing,.wc-boot{font-family:'Source Sans 3',system-ui,sans-serif;color:var(--txt);
  background:var(--navy);min-height:100vh}
.wc-fade{opacity:0;animation:wcFade .6s ease forwards}
@keyframes wcFade{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}

/* boot */
.wc-boot{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;font-family:'Bebas Neue';letter-spacing:4px;color:var(--dim);font-size:20px}
.wc-ball{width:46px;height:46px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff,#cdd6e6 40%,#7d8aa0);
  box-shadow:0 0 30px rgba(43,127,255,.5);animation:wcSpin 1s linear infinite}
@keyframes wcSpin{to{transform:rotate(360deg)}}

/* landing */
.wc-landing{position:relative;display:flex;align-items:center;justify-content:center;
  overflow:hidden;padding:40px 20px}
.wc-pitch{position:absolute;inset:0;background:
  repeating-linear-gradient(180deg,#0a0e1a 0 60px,#0c1322 60px 120px);opacity:.6}
.wc-glow{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55;animation:wcDrift 14s ease-in-out infinite}
.wc-glow-1{width:480px;height:480px;background:var(--pink);top:-120px;left:-80px}
.wc-glow-2{width:520px;height:520px;background:var(--blue);bottom:-160px;right:-100px;animation-delay:-4s}
.wc-glow-3{width:360px;height:360px;background:var(--teal);top:40%;left:55%;animation-delay:-8s;opacity:.4}
@keyframes wcDrift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-30px)}}
.wc-landing-inner{position:relative;text-align:center;max-width:680px}
.wc-kicker{font-family:'Bebas Neue';letter-spacing:5px;font-size:15px;
  background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:10px}
.wc-hero{font-family:'Bebas Neue';font-size:clamp(64px,14vw,140px);line-height:.86;margin:0;
  letter-spacing:2px;text-shadow:0 0 60px rgba(255,45,120,.25)}
.wc-hero-amp{display:inline-block;margin:0 .1em;background:var(--grad);
  -webkit-background-clip:text;background-clip:text;color:transparent;transform:translateY(-.05em)}
.wc-sub{color:var(--dim);font-size:17px;line-height:1.6;max-width:520px;margin:18px auto 30px}
.wc-google{display:inline-flex;align-items:center;gap:11px;background:#fff;color:#1a1a1a;
  border:none;padding:15px 28px;border-radius:14px;font-weight:700;font-size:16px;cursor:pointer;
  box-shadow:0 10px 40px rgba(0,0,0,.4);transition:transform .15s,box-shadow .15s}
.wc-google:hover{transform:translateY(-2px);box-shadow:0 16px 50px rgba(43,127,255,.4)}
.wc-flagstrip{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:34px;font-size:26px;filter:saturate(1.1)}

/* top bar */
.wc-top{position:sticky;top:0;z-index:20;background:rgba(10,14,26,.82);
  backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.wc-top-inner{max-width:920px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:18px}
.wc-brand{display:flex;align-items:center;gap:11px}
.wc-trophy{font-size:30px;filter:drop-shadow(0 0 12px rgba(255,201,60,.6))}
.wc-brand-sm{font-family:'Bebas Neue';letter-spacing:3px;font-size:11px;color:var(--gold)}
.wc-brand-lg{font-family:'Bebas Neue';letter-spacing:1.5px;font-size:22px;line-height:.9}
.wc-nav{display:flex;gap:4px;margin-left:auto}
.wc-tab{background:transparent;border:none;color:var(--dim);padding:9px 16px;border-radius:10px;
  font-family:'Bebas Neue';letter-spacing:1.5px;font-size:17px;cursor:pointer;transition:.15s}
.wc-tab:hover{color:var(--txt)}
.wc-tab.on{background:var(--grad);color:#fff}
.wc-user{display:flex;align-items:center;gap:9px}
.wc-user img{width:30px;height:30px;border-radius:50%;border:2px solid var(--line)}
.wc-user-name{font-size:14px;color:var(--dim)}
.wc-out{background:transparent;border:1px solid var(--line);color:var(--dim);
  padding:6px 13px;border-radius:9px;font-size:13px;cursor:pointer;transition:.15s}
.wc-out:hover{border-color:var(--pink);color:var(--txt)}

/* main */
.wc-main{max-width:920px;margin:0 auto;padding:26px 18px 70px}
.wc-h2{font-family:'Bebas Neue';font-size:32px;letter-spacing:1px;margin:0}
.wc-muted{color:var(--dim);font-size:14px;margin:4px 0 0}

/* picks */
.wc-picks-head{display:flex;justify-content:space-between;align-items:flex-end;
  gap:16px;margin-bottom:22px;flex-wrap:wrap}
.wc-save{background:var(--grad);color:#fff;border:none;padding:13px 26px;border-radius:13px;
  font-weight:800;font-size:15px;cursor:pointer;white-space:nowrap;
  box-shadow:0 8px 30px rgba(255,45,120,.35);transition:transform .15s}
.wc-save:hover{transform:translateY(-2px)}
.wc-save.done{background:linear-gradient(135deg,#19e6c8,#2b7fff);box-shadow:0 8px 30px rgba(25,230,200,.35)}
.wc-dead{background:rgba(255,45,120,.12);border:1px solid var(--pink);color:#ff7aa6;
  padding:14px 18px;border-radius:14px;margin-bottom:22px;font-size:15px}
.wc-round{background:var(--panel);border:1px solid var(--line);border-radius:18px;
  margin-bottom:18px;overflow:hidden;transition:border-color .25s}
.wc-round.done{border-color:rgba(25,230,200,.45);box-shadow:0 0 0 1px rgba(25,230,200,.15)}
.wc-round-head{display:flex;justify-content:space-between;align-items:center;
  padding:16px 20px;border-bottom:1px solid var(--line);
  background:linear-gradient(90deg,rgba(43,127,255,.07),transparent)}
.wc-round-name{font-family:'Bebas Neue';font-size:24px;letter-spacing:1px;display:block}
.wc-round-lock{font-size:12px;color:var(--dim)}
.wc-count{font-family:'Bebas Neue';font-size:24px;letter-spacing:1px;color:var(--gold);
  min-width:50px;text-align:right}
.wc-count.done{color:var(--teal)}
.wc-round-body{padding:16px 20px}
.wc-group{margin-bottom:14px}
.wc-group-tag{font-family:'Bebas Neue';letter-spacing:2px;font-size:12px;color:var(--dim);margin-bottom:7px}
.wc-chips{display:flex;flex-wrap:wrap;gap:7px}
.wc-chip{display:inline-flex;align-items:center;gap:7px;background:var(--navy2);
  border:1px solid var(--line);color:var(--txt);padding:8px 13px;border-radius:11px;
  font-size:13.5px;font-weight:600;cursor:pointer;transition:transform .12s,background .15s,border-color .15s}
.wc-chip:hover:not(:disabled){transform:translateY(-2px);border-color:var(--blue)}
.wc-chip-flag{font-size:16px;line-height:1}
.wc-chip.picked{background:var(--grad);border-color:transparent;color:#fff;font-weight:700}
.wc-chip.locked{opacity:.35;cursor:not-allowed;color:var(--dim)}
.wc-chip.win{background:linear-gradient(135deg,#19e6c8,#10b981);color:#04231b}
.wc-chip.loss{background:linear-gradient(135deg,#ff2d78,#e11d48);color:#fff}
.wc-chip-mark{font-weight:800;margin-left:2px}

/* standings */
.wc-stand-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px}
.wc-alive-pill{font-family:'Bebas Neue';letter-spacing:1.5px;font-size:14px;
  background:var(--grad);color:#fff;padding:7px 15px;border-radius:20px}
.wc-entry{display:flex;align-items:center;gap:13px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;padding:13px 17px;margin-bottom:9px}
.wc-entry.out{opacity:.55}
.wc-entry-rank{font-family:'Bebas Neue';font-size:20px;color:var(--dim);min-width:22px}
.wc-entry-pic{width:32px;height:32px;border-radius:50%;border:2px solid var(--line)}
.wc-entry-name{font-weight:700;flex:1}
.wc-entry-stat{font-family:'Bebas Neue';letter-spacing:1px;font-size:16px;color:var(--pink)}
.wc-entry-stat.alive{color:var(--teal)}

/* admin */
.wc-admin-rounds{display:flex;flex-wrap:wrap;gap:7px;margin:16px 0 18px}
.wc-rtab{background:var(--panel);border:1px solid var(--line);color:var(--dim);
  padding:8px 14px;border-radius:10px;font-family:'Bebas Neue';letter-spacing:1px;
  font-size:15px;cursor:pointer;transition:.15s}
.wc-rtab.on{background:var(--grad);color:#fff;border-color:transparent}
.wc-admin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.wc-admin-row{display:flex;align-items:center;justify-content:space-between;
  background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 12px}
.wc-admin-team{font-size:13.5px;font-weight:600}
.wc-admin-btns{display:flex;gap:5px}
.wc-wl{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);
  background:transparent;color:var(--dim);font-weight:800;cursor:pointer;transition:.12s}
.wc-wl.w.on{background:var(--teal);color:#04231b;border-color:transparent}
.wc-wl.l.on{background:var(--pink);color:#fff;border-color:transparent}

/* setup */
.wc-setup-uid{display:flex;align-items:center;justify-content:space-between;gap:14px;
  background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:18px 0}
.wc-setup-label{font-family:'Bebas Neue';letter-spacing:2px;font-size:12px;color:var(--dim);margin-bottom:5px}
.wc-setup-code{font-size:14px;color:var(--teal);word-break:break-all;font-family:ui-monospace,monospace}
.wc-copy{background:var(--grad);color:#fff;border:none;padding:10px 18px;border-radius:10px;
  font-weight:700;cursor:pointer;white-space:nowrap}
.wc-steps{color:var(--txt);line-height:1.9;font-size:15px;padding-left:22px}
.wc-steps code{background:var(--navy2);border:1px solid var(--line);padding:1px 7px;
  border-radius:6px;font-size:13px;color:var(--gold)}
    `}</style>
  );
}
