# World Cup 2026 Survivor Pool

React + Firebase (Google Auth + Firestore) survivor pool. Deploys to Netlify.

## Setup order
1. **Firebase project** → add Web app → copy SDK config (6 values).
2. **Auth:** enable Google sign-in. Add your Netlify domain under
   Authentication → Settings → Authorized domains.
3. **Firestore:** create DB → Rules tab → paste `firestore.rules` → Publish.
4. **Env vars:** copy `.env.example` to `.env`, fill in. Set the same
   VITE_FB_* vars in Netlify → Site settings → Environment variables.
5. **GitHub:** push repo. Netlify → New site from Git → pick it
   (build/publish already in netlify.toml).
6. **Admin:** sign in once, then in Firestore create
   config/admins = { uids: ["your-uid"] } (UID from Auth → Users).

## Run
    npm install
    npm run dev      # local
    npm run build    # production -> dist/

## Notes
- R32/QF/SF deadlines are estimates; edit ROUNDS in src/App.jsx.
- 48 teams / 12 groups from the Dec 5 2025 draw.
- functions/ is optional API automation; run on manual admin marking first.
