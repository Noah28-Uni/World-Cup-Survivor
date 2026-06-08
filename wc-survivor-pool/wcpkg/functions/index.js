/*
  Optional results automation for the World Cup Survivor Pool.
  Writes the SAME results/{round} docs the web app reads, so the UI
  needs zero changes when you switch from manual admin marking to this.

  IMPORTANT: this runs server-side, so a PAID API key is safe here
  (set it with: firebase functions:config:set sportsapi.key="...").
  Deploy only when ready:  firebase deploy --only functions

  The web app keeps working on manual admin input until then — this is
  purely additive. If the API ever flakes mid-tournament (the failure
  mode that burned the PGA app), an admin can still mark results by hand
  in the Admin tab and override whatever this wrote.
*/

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();
const API_KEY = defineSecret("SPORTSAPI_KEY");

// Map your team display names to whatever the API returns, if they differ.
// Keys = API name, values = the exact strings used in the app's GROUPS.
const NAME_MAP = {
  "USA": "United States",
  "Korea Republic": "South Korea",
  "Côte d'Ivoire": "Ivory Coast",
  "Czechia": "Czech Republic",
  "Türkiye": "Turkey",
  // add others as needed once you see live API payloads
};
const normalize = (n) => NAME_MAP[n] || n;

// Which round are we currently scoring? Stored in config/state = { currentRound }.
async function getCurrentRound() {
  const snap = await db.doc("config/state").get();
  return snap.exists ? snap.data().currentRound : null;
}

// Replace the body with your chosen provider's fixtures endpoint.
function fetchFixtures(apiKey) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.example-sports-provider.com",
      path: "/v1/worldcup/2026/fixtures?status=finished",
      headers: { Authorization: `Bearer ${apiKey}` },
    };
    https.get(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

exports.syncResults = onSchedule(
  { schedule: "every 30 minutes", secrets: [API_KEY] },
  async () => {
    const round = await getCurrentRound();
    if (!round) { console.log("No currentRound set; skipping."); return; }

    let payload;
    try {
      payload = await fetchFixtures(API_KEY.value());
    } catch (e) {
      console.error("API fetch failed, leaving manual results intact:", e);
      return; // never clobber admin data on a fetch error
    }

    const updates = {};
    for (const fx of payload.fixtures || []) {
      if (!fx.finished) continue;
      // Knockout: winner advances. Group stage: handled separately (see note).
      if (fx.winner) updates[normalize(fx.winner)] = "win";
      if (fx.loser)  updates[normalize(fx.loser)]  = "loss";
    }

    if (Object.keys(updates).length === 0) {
      console.log("No finished fixtures to write yet.");
      return;
    }

    await db.doc(`results/${round}`).set(updates, { merge: true });
    console.log(`results/${round} updated:`, updates);
  }
);

/*
  GROUP STAGE NOTE:
  "Advancing to Round of 32" isn't a single match win — it's finishing
  top 2 in the group, or one of the 8 best 3rd-place teams. So for the
  "group" round, don't use match winners. Instead, once all group games
  are final, compute the 32 qualifiers and write "win" for each qualifier
  and "loss" for everyone eliminated. Easiest reliable approach: an admin
  flips the group round by hand once qualification is mathematically set,
  and let this function handle only the knockout rounds (r32 onward).
*/
