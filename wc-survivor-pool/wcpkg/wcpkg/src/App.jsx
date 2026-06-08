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

  // Pick popularity per round → { roundId: { team: count } }, plus total entries.
  // Only revealed in the UI once a round's picks are locked (entry deadline passed
  // for group, or the round has any results in), so players don't copy each other early.
  const popularity = useMemo(() => {
    const p = {};
    entries.forEach((e) => {
      Object.entries(e.picks || {}).forEach(([rid, teams]) => {
        p[rid] = p[rid] || {};
        teams.forEach((t) => (p[rid][t] = (p[rid][t] || 0) + 1));
      });
    });
    return p;
  }, [entries]);
  const totalEntries = entries.length;

  // A round is locked until the PREVIOUS round is fully resolved as a win:
  // you picked the required number of teams AND all of them have a "win" result.
  const isRoundLocked = useMemo(() => (roundIdx) => {
    if (roundIdx === 0) return false; // group stage always open
    const prev = ROUNDS[roundIdx - 1];
    const prevPicks = picks[prev.id] || [];
    if (prevPicks.length < prev.picks) return true;        // didn't finish picking
    const prevRes = results[prev.id] || {};
    return !prevPicks.every((t) => prevRes[t] === "win");  // not all confirmed winners
  }, [picks, results]);

  function togglePick(roundId, team, max, locked) {
    if (!user || locked) return; setSaved(false);
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
              <Picks {...{ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus, isRoundLocked, popularity, totalEntries }} />
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

        <div className="wc-rules wc-fade" style={{ animationDelay: ".75s" }}>
          <div className="wc-rules-title">HOW IT WORKS</div>
          <div className="wc-rules-grid">
            <div className="wc-rule">
              <span className="wc-rule-num">01</span>
              <div>
                <strong>Group Stage</strong>
                Pick 4 teams you think will reach the Round of 32. All 4 must advance or you're out.
              </div>
            </div>
            <div className="wc-rule">
              <span className="wc-rule-num">02</span>
              <div>
                <strong>Knockout Stage</strong>
                Pick 1 team per round — except the Round of 32, Round of 16, and Quarterfinals, where you pick 2.
              </div>
            </div>
            <div className="wc-rule">
              <span className="wc-rule-num">03</span>
              <div>
                <strong>Win or Go Home</strong>
                Every pick in a round must win — in regulation, extra time, or a shootout. One loss eliminates you.
              </div>
            </div>
            <div className="wc-rule">
              <span className="wc-rule-num">04</span>
              <div>
                <strong>Each Team Once</strong>
                You can use a team a single time across the whole contest. The last surviving entry wins.
              </div>
            </div>
          </div>
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
function Picks({ picks, togglePick, usedTeams, results, saveEntry, saved, myStatus, isRoundLocked, popularity, totalEntries }) {
  const [picker, setPicker] = useState(null); // { roundId, roundIdx } or null

  return (
    <div className="wc-picks">
      <div className="wc-picks-head wc-fade">
        <div>
          <h2 className="wc-h2">Your Bracket</h2>
          <p className="wc-muted">Build your run left to right. Each round unlocks once your previous picks all win.</p>
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

      <div className="wc-bracket-scroll">
        <div className="wc-bracket">
          {ROUNDS.map((r, i) => {
            const sel = picks[r.id] || [];
            const done = sel.length === r.picks;
            const locked = isRoundLocked(i);
            // Reveal pick popularity only once this round has any results posted
            // (i.e. picks are locked in / games underway) — never before.
            const revealPopularity = Object.keys(results[r.id] || {}).length > 0;
            return (
              <div key={r.id} className={"wc-col" + (locked ? " locked" : "") + (done ? " done" : "")}>
                <div className="wc-col-head">
                  <div className="wc-col-name">{r.label}</div>
                  <div className="wc-col-meta">
                    {locked ? <span className="wc-lockicon">🔒</span>
                      : <span className={"wc-col-count" + (done ? " done" : "")}>{sel.length}/{r.picks}</span>}
                  </div>
                </div>

                <div className="wc-slots">
                  {Array.from({ length: r.picks }).map((_, slotIdx) => {
                    const team = sel[slotIdx];
                    const res = team ? (results[r.id] || {})[team] : null;
                    const count = team ? (popularity[r.id]?.[team] || 0) : 0;
                    const pct = totalEntries > 0 ? Math.round((count / totalEntries) * 100) : 0;
                    let cls = "wc-slot";
                    if (team) cls += " filled";
                    if (res === "win") cls += " win celebrate";
                    if (res === "loss") cls += " loss";
                    if (locked) cls += " locked";
                    return (
                      <button key={slotIdx} className={cls}
                        disabled={locked}
                        onClick={() => {
                          if (locked) return;
                          if (team) togglePick(r.id, team, r.picks, locked); // tap filled = remove
                          else setPicker({ roundId: r.id, roundIdx: i });
                        }}>
                        {team ? (
                          <>
                            <span className="wc-slot-flag">{FLAG[team]}</span>
                            <span className="wc-slot-team">{team}</span>
                            {res === "win" && <span className="wc-slot-mark win">✓</span>}
                            {res === "loss" && <span className="wc-slot-mark loss">✕</span>}
                            {revealPopularity && (
                              <span className="wc-slot-pop">{pct}%</span>
                            )}
                          </>
                        ) : locked ? (
                          <span className="wc-slot-empty">Locked</span>
                        ) : (
                          <span className="wc-slot-empty">+ Pick team</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {picker && (
        <TeamPicker
          round={ROUNDS.find((r) => r.id === picker.roundId)}
          picks={picks} usedTeams={usedTeams} results={results}
          onPick={(team) => {
            togglePick(picker.roundId, team, ROUNDS[picker.roundIdx].picks, false);
            // close if this fills the round
            const after = (picks[picker.roundId] || []).length + 1;
            if (after >= ROUNDS[picker.roundIdx].picks) setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function TeamPicker({ round, picks, usedTeams, results, onPick, onClose }) {
  const sel = picks[round.id] || [];
  const body = round.id === "group"
    ? Object.entries(GROUPS).map(([g, teams]) => (
        <div key={g} className="wc-group">
          <div className="wc-group-tag">GROUP {g}</div>
          <div className="wc-chips">
            {teams.map(([t]) => <PickerChip key={t} {...{ t, sel, usedTeams, onPick }} />)}
          </div>
        </div>
      ))
    : <div className="wc-chips">
        {ALL_TEAMS.map((t) => <PickerChip key={t} {...{ t, sel, usedTeams, onPick }} />)}
      </div>;

  return (
    <div className="wc-modal" onClick={onClose}>
      <div className="wc-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="wc-modal-head">
          <div>
            <div className="wc-modal-title">{round.label}</div>
            <div className="wc-muted">Pick {round.picks} · {sel.length} selected</div>
          </div>
          <button className="wc-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="wc-modal-body">{body}</div>
      </div>
    </div>
  );
}

function PickerChip({ t, sel, usedTeams, onPick }) {
  const picked = sel.includes(t);
  const usedLock = usedTeams.has(t) && !picked;
  let cls = "wc-chip";
  if (picked) cls += " picked";
  if (usedLock) cls += " locked";
  return (
    <button className={cls} disabled={usedLock} onClick={() => onPick(t)}>
      <span className="wc-chip-flag">{FLAG[t]}</span>{t}
      {picked && <span className="wc-chip-mark">✓</span>}
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
.wc-lockicon{font-size:15px}

/* bracket */
.wc-bracket-scroll{overflow-x:auto;padding:6px 2px 18px;-webkit-overflow-scrolling:touch}
.wc-bracket{display:flex;gap:0;min-width:max-content;align-items:stretch}
.wc-col{position:relative;min-width:212px;padding:0 20px;display:flex;flex-direction:column;
  border-left:1px dashed rgba(255,255,255,.07)}
.wc-col:first-child{border-left:none;padding-left:2px}
.wc-col.locked{opacity:.5}
.wc-col.done .wc-col-name{color:var(--teal)}
.wc-col-head{margin-bottom:12px}
.wc-col-name{font-family:'Bebas Neue';font-size:20px;letter-spacing:.5px;line-height:1;transition:color .3s}
.wc-col-meta{margin-top:3px}
.wc-col-count{font-family:'Bebas Neue';font-size:15px;color:var(--gold);letter-spacing:1px}
.wc-col-count.done{color:var(--teal)}
.wc-slots{display:flex;flex-direction:column;gap:12px;justify-content:center;flex:1}
.wc-slot{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:48px;
  background:var(--navy2);border:1.5px dashed var(--line);border-radius:12px;
  padding:8px 12px;cursor:pointer;color:var(--dim);font-size:13.5px;font-weight:600;
  transition:transform .14s cubic-bezier(.2,.8,.2,1),border-color .15s,background .15s,box-shadow .2s;
  text-align:left}
.wc-slot:hover:not(:disabled){transform:translateY(-2px) scale(1.015);border-color:var(--blue);
  color:var(--txt);box-shadow:0 6px 20px rgba(43,127,255,.18)}
.wc-slot:active:not(:disabled){transform:scale(.97)}
/* connector line from a filled slot to the next column */
.wc-slot.filled::after{content:"";position:absolute;right:-21px;top:50%;width:20px;height:2px;
  background:linear-gradient(90deg,var(--teal),transparent);opacity:.5}
.wc-col:last-child .wc-slot.filled::after{display:none}
.wc-slot.filled{background:var(--grad);border:1.5px solid transparent;color:#fff;font-weight:700;
  box-shadow:0 4px 16px rgba(255,45,120,.25)}
.wc-slot.win{background:linear-gradient(135deg,#19e6c8,#10b981);color:#04231b}
.wc-slot.win::after{background:linear-gradient(90deg,#19e6c8,transparent);opacity:.8}
.wc-slot.loss{background:linear-gradient(135deg,#ff2d78,#e11d48);color:#fff}
.wc-slot.loss::after{display:none}
.wc-slot.locked{cursor:not-allowed;border-style:solid;opacity:.7}
.wc-slot.celebrate{animation:wcPop .5s cubic-bezier(.2,1.4,.4,1)}
@keyframes wcPop{0%{transform:scale(1)}40%{transform:scale(1.08)}100%{transform:scale(1)}}
.wc-slot-flag{font-size:18px;line-height:1}
.wc-slot-team{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wc-slot-mark{font-weight:800;font-size:15px}
.wc-slot-pop{position:absolute;right:8px;bottom:-9px;font-size:10px;font-weight:800;
  letter-spacing:.5px;background:var(--navy);color:var(--gold);border:1px solid var(--line);
  padding:1px 7px;border-radius:20px;animation:wcFade .4s ease}
.wc-slot-empty{opacity:.7}

/* team picker modal */
.wc-modal{position:fixed;inset:0;z-index:50;background:rgba(4,7,14,.7);
  backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center;
  animation:wcFade .2s ease}
.wc-modal-card{background:var(--navy2);border:1px solid var(--line);border-radius:22px 22px 0 0;
  width:100%;max-width:620px;max-height:82vh;display:flex;flex-direction:column;
  animation:wcSlideUp .3s cubic-bezier(.2,.8,.2,1)}
@media(min-width:640px){.wc-modal{align-items:center}.wc-modal-card{border-radius:22px}}
@keyframes wcSlideUp{from{transform:translateY(40px);opacity:.6}to{transform:none;opacity:1}}
.wc-modal-head{display:flex;justify-content:space-between;align-items:center;
  padding:18px 20px;border-bottom:1px solid var(--line)}
.wc-modal-title{font-family:'Bebas Neue';font-size:24px;letter-spacing:.5px}
.wc-modal-x{background:var(--panel);border:1px solid var(--line);color:var(--txt);
  width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:14px}
.wc-modal-body{padding:18px 20px;overflow-y:auto}

/* landing rules */
.wc-rules{margin-top:46px;text-align:left;max-width:560px;margin-left:auto;margin-right:auto}
.wc-rules-title{font-family:'Bebas Neue';letter-spacing:4px;font-size:14px;color:var(--dim);
  text-align:center;margin-bottom:18px}
.wc-rules-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:560px){.wc-rules-grid{grid-template-columns:1fr}}
.wc-rule{display:flex;gap:13px;background:rgba(20,29,48,.6);border:1px solid var(--line);
  border-radius:15px;padding:16px;backdrop-filter:blur(8px)}
.wc-rule-num{font-family:'Bebas Neue';font-size:22px;background:var(--grad);
  -webkit-background-clip:text;background-clip:text;color:transparent;line-height:1}
.wc-rule strong{display:block;margin-bottom:4px;font-size:15px}
.wc-rule div{font-size:13.5px;color:var(--dim);line-height:1.5}

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
