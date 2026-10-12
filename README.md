# Symbiote Calling — v7.0.0

Dial 101 AI calling agents from a phone-style UI, powered by Gemini Live — or build your own. Each agent has its own fictional number; pick from the directory, punch it into the dialer, and a phone UI opens with a live voice call, timer, keypad, and chat. Agents remember you: every call saves notes, appointments, and a transcript to the Memory page, and agents recall past calls when you ring again.

Local demo for now (`npm install && npm run dev` → http://localhost:3000).

## Quick start

```bash
npm install
npm run dev
```

1. Open http://localhost:3000 — the **login screen** appears first. Paste your Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey)) and give it a label. The key stays on this device (localStorage) — only its SHA-256 hash ever leaves it. You can keep several key profiles and switch between them in **Settings → Key profiles**.
2. **Agents** tab → search, filter by gender/role, tap a card for the agent's profile (per-agent call stats), swipe right or tap Call — e.g. Elena `+1 (555) 010-0003`.
3. Or open the **Dialer**, punch in a number, hit call — recent numbers show below the pad.
4. The phone UI opens: *Dialing… → Connecting… → greeting… → live timer (mm:ss)*, mute, keypad (real DTMF tones), chat (type → agent answers by voice), in-call notes, minimize-to-bubble, hang up. Say "cut the call" / "khuda hafiz" and the agent says goodbye and hangs up itself.
5. **History** tab logs every call — filter by agent, date range, or completed/missed.
6. **Memory** tab: every call is saved with the agent's notes (appointments, facts) and the full transcript; download any transcript as a text file. Call the same agent again and it remembers your past calls.
7. **Dashboard** tab: usage stats for your current key, plus one-tap recent calls.
8. **Docs** tab: the full user guide (also at `/docs.html`).

> Mic permission is requested only when a call starts (toggleable in Settings). If the mic is unavailable, the call continues in chat mode — the agent still answers by voice.

## What's new in v7.0.0

**🔑 Key login (the whole app is gated).** Your API key is your login — the app won't render until a key is active. Keys live in localStorage only; REST calls carry only the key's hash (`x-key-hash`). Manage multiple profiles (labels, switch, delete) from Settings. Switching keys switches your entire world: each key gets its own history, memories, custom agents, usage stats, and audit log — nothing is ever wiped or leaked between keys.

**🧑‍💼 Custom agent builder.** The **Custom Agents** tab lets you build unlimited voice agents: name (required), number (required — any number), role (required, anything you like), tone (professional / friendly / confident / casual), voice, prompt (optional), and an optional profile photo (default caller avatar if skipped). Saved per API key — your agents load whenever that key does. Custom agents dial, talk, remember, and appear everywhere built-ins do (directory, dialer, history, stats). Clone any built-in agent from its profile sheet to pre-fill the builder. SymAgent knows all your custom agents and can transfer callers to them.

**🎙️ Greeting fix (P0).** The reported bug — no agent ever greeting first — gets a proper handshake: one trigger on setup confirmation, a single ~6s retry, a ~12s failure path that shows *"Say hello to begin"*, and client-side diagnostics (`window.GreetingDiag`) feeding the call overlay (*greeting…* → timer / transcript bubble / hint). See "Verified / not verified" below.

**📇 Directory UX.** Searchable/filterable agent directory with per-agent **profile sheets** (avatar, number, role, tone, voice, call stats, Call / Clone buttons) and **swipe gestures** (swipe right → call, swipe left → profile).

**📞 Call experience.** In-call **notes** (saved to the call record on hangup), **floating call bubble** (minimize the phone UI, keep talking), **connection meter** (mic level + network state), **quota timer alerts** (visual + beep when a per-call budget is crossed), **dialer recents**, and **transcript download** (`.txt`) from any memory.

**🧹 Hygiene.** Auto-cleanup: device recordings + server call records + memory transcripts older than N days are deleted automatically (N configurable in Settings, default 30; server reads `RETENTION_DAYS` env). **Accent color picker** in Settings recolors the whole app (including the key-login overlay). **History filters** (agent / date range / completed-missed).

**🛡️ Rate limiting, usage & audit.** Max 3 concurrent calls per key (extra callers get a clean "too many concurrent calls" message); per-key call/minute usage at `GET /api/v7/key/usage`; a server-side audit log at `GET /api/v7/audit`.

**📚 Docs page.** A complete start-to-end user guide as its own page (`/docs.html`, linked from the nav).

## SymAgent — the 101st agent (company representative)

**SymAgent** (`+1 (555) 010-0101`) is the official AI representative of **Symbiote Systems** — the agency behind this platform. It knows:

- **The company**: services (AI calling/voice agents, websites, AI chatbots, AI automation on Make/n8n), portfolio, socials, and contact (email + WhatsApp).
- **All 100 calling agents** — plus **your custom agents**: a compact directory of every agent (name, niche, number) is injected into its prompt at call time, generated fresh from `src/agents.js` and your per-key custom store, so it never drifts.
- **The rules**: no pricing talk, no appointment booking — it informs, impresses, and captures leads. When a caller is interested, it collects name, email, phone, and the service they want, then saves it via `save_note` so the team can follow up.

**`transfer_call` (SymAgent only — including to your custom agents).** Ask SymAgent about a specialist service and it offers to connect you — say yes and it transfers you straight into a call with that specialist, built-in or custom. No other agent (and no custom agent) can transfer.

**`share_links` (SymAgent only):** when a caller asks for socials, portfolio, or contact details, the agent drops **clickable link chips** into the in-call chat — Instagram, Threads, X, LinkedIn, Pinterest, Gumroad, portfolio sites, client work (Aquifer Reach LLC), email, WhatsApp. URLs are server-side constants, so the model can never invent or inject its own links.

## The 100 agents

Fictional +1 (555)… numbers, working only inside this app. Each agent has a gender-matched voice (feminine voices for female agents, masculine for male) and a prompt line telling the model to speak as that gender.

| # | Agent | Niche | # | Agent | Niche | # | Agent | Niche | # | Agent | Niche |
|---|-------|-------|---|-------|-------|---|-------|-------|---|-------|-------|
| 1 | Jacob | Real Estate Advisor | 26 | Thiago | Spa Booker | 51 | Zoey | Tutor Booker | 76 | Layla | History Guide |
| 2 | Roman | Restaurant Host | 27 | Aria | Moving Coordinator | 52 | Isaac | Laundry Assistant | 77 | Santiago | Aviation Info Guide |
| 3 | Elena | Travel Concierge | 28 | Cooper | Jewelry Consultant | 53 | Oliver | Childcare Finder | 78 | Sofia | Outdoor Guide |
| 4 | Lucas | Clinic Receptionist | 29 | Mila | Career Counselor | 54 | Wesley | Senior Care Guide | 79 | Nora | Sleep Coach |
| 5 | Mia | Tech Support Guide | 30 | Thomas | Home Services Dispatcher | 55 | Hudson | Photography Booker | 80 | Emily | Running Coach |
| 6 | Grayson | Banking Assistant | 31 | William | Interior Designer | 56 | Mason | Catering Assistant | 81 | Sophia | Reading Guide |
| 7 | Noah | Car Dealership | 32 | Charles | Market Educator | 57 | Rowan | Bakery Assistant | 82 | Alexander | Film Guide |
| 8 | Harper | Salon Booker | 33 | Beau | Online Store Helper | 58 | Evelyn | Phone Repair Guide | 83 | Asher | Dance Instructor |
| 9 | Sebastian | Legal Intake Assistant | 34 | Amelia | Music Teacher | 59 | John | Speaking Coach | 84 | Avery | DIY Repair Guide |
| 10 | Hazel | Boutique Stylist | 35 | Elizabeth | Exam Prep Coach | 60 | Charlotte | Math Tutor | 85 | Emilia | Makeup Tutor |
| 11 | Eleanor | Fitness Coach | 36 | Carter | Florist | 61 | Julian | Driving Guide | 86 | Henry | Car Care Guide |
| 12 | Benjamin | Admissions Advisor | 37 | Grace | Nutrition Guide | 62 | James | Crypto Educator | 87 | Weston | Singing Coach |
| 13 | Waylon | Insurance Advisor | 38 | Logan | Ride Dispatcher | 63 | Elijah | Tax Info Guide | 88 | Violet | Photography Tutor |
| 14 | Isaiah | Interview Coach | 39 | Chloe | Visa Info Guide | 64 | Ava | Resume Coach | 89 | Levi | Skincare Guide |
| 15 | Camila | Language Tutor | 40 | Elias | Cleaning Service Booker | 65 | Penelope | Gardening Guide | 90 | Luna | Coffee Guide |
| 16 | Anthony | Event Planner | 41 | Gabriel | Sports Coach | 66 | Ezra | Solar Advisor | 91 | Ellie | Etiquette Coach |
| 17 | Maverick | IT Helpdesk | 42 | Ethan | Luxury Concierge | 67 | Lily | Online Seller Guide | 92 | Luca | Fishing Guide |
| 18 | Madison | Wellness Companion | 43 | Bennett | Parcel Assistant | 68 | Miles | Tailoring Booker | 93 | Samuel | Poetry Tutor |
| 19 | Scarlett | Business Consultant | 44 | Dylan | Cyber Safety Guide | 69 | Abigail | Mehndi Artist Booker | 94 | Joseph | Magic Coach |
| 20 | Wyatt | Customer Support | 45 | Leo | Parenting Guide | 70 | Michael | Barber Booker | 95 | Matthew | Meditation Guide |
| 21 | Owen | Pharmacy Assistant | 46 | Isabella | Car Rental Agent | 71 | Liam | Sales Master | 96 | Jackson | Drone Guide |
| 22 | Daniel | HR Recruiter | 47 | Emma | Gift Advisor | 72 | Maya | Chess Coach | 97 | Eliana | Aquarium Guide |
| 23 | Luke | Loan Advisor | 48 | Olivia | Freelance Guide | 73 | Caleb | Yoga Instructor | 98 | Theodore | Grilling Guide |
| 24 | Nova | Pet Care Guide | 49 | Mateo | Recipe Guide | 74 | Isla | Watch Guide | 99 | Jack | Cake Decorating Tutor |
| 25 | Gianna | Grocery Assistant | 50 | David | Gaming Coach | 75 | Josiah | Craft Guide | 100 | Aurora | Comedy Coach |

Full numbers: `+1 (555) 010-0001` … `+1 (555) 010-0100` (see `src/agents.js`).

Sensitive roles carry hard limits in their prompts: Harper never diagnoses, Omar is not a lawyer, Sofia never touches accounts or asks for PINs/OTPs, Tara is not a therapist, Neil gives education not financial advice, Elias/Freya/Sana/Aisha give general info only and refer professionals.

## Features

- **Greeting handshake**: one greeting trigger on connect, a single ~6s retry, and a ~12s failure path — the overlay shows *greeting…*, then the timer on audio, a transcript bubble on text-only output, or a *"Say hello to begin"* hint on silence.
- **Real-time web search**: every agent has the `web_search` tool — a 4-provider chain (DuckDuckGo instant answers → Wikipedia → Google News RSS for real-time news → DDG web results), per-provider breakers and 10s timeouts so one slow provider can't kill search. Ask about current prices, news, hours, schedules.
- **Agent hangup**: say "cut the call" / "khuda hafiz" / goodbye — the agent says farewell and ends the call itself (`end_call` tool, 4s grace for the goodbye audio).
- **100 AI portraits**: every agent has its own AI-generated face-portrait avatar (face only, no letters) — with a procedural SVG fallback if a photo is ever missing. Deploy note: the GitHub repo stores avatars as base64 sidecars (`public/avatars/<id>.jpg.b64`) because the push tooling is text-only; `server.js` decodes and serves them as real JPEGs automatically.
- **SymAgent hero + clickable links**: the 101st agent's `share_links` tool drops clickable social/portfolio/contact chips into the in-call chat.
- **Subtle motion & SFX**: cards rise in with a stagger, the phone slides up, buttons press-scale, the avatar pulses while speaking — plus tiny WebAudio blips for tap, connect, hangup, and messages.
- **Smart dialer**: start typing a number and matching agents appear above the pad, phone-style; exact matches highlighted; recent calls listed below the pad for one-tap redial.
- **Memory**: every call auto-saves notes (appointments, facts the agent records via `save_note`), plus the full transcript. The Memory page shows per-call details and transcript downloads; calling the same agent again injects its recent memories into the prompt so it remembers you.
- **Key-scoped data (v7)**: memories + history + custom agents are tied to your API key (by hash — the key is never stored). Each key's data lives in its own partition files (`calls_<hash>.json`, `memories_<hash>.json`, `custom_<hash>.json`); switching keys switches worlds, never wipes.
- **Key profiles**: name your keys, switch between them, delete them — all from Settings. The login overlay supports multiple saved profiles.
- **Custom agents**: unlimited, per-key, with avatar upload, tone select, prompt templates, and clone-from-built-in.
- **Light/dark themes + accent picker**: warm light default (easy on the eyes), one-tap dark mode, remembered — plus 8 accent colors that recolor the whole app including the login screen.
- **In-call notes, floating bubble, connection meter**: jot notes mid-call (saved with the call), minimize the phone UI into a draggable bubble without dropping audio, and watch mic level + network state live.
- **Quota alerts**: set a per-call minute budget and get a visual + audio alert when it's crossed.
- **Call history filters**: filter by agent, date range, or completed/missed — plus one-tap call-back and per-call detail.
- **Dashboard**: usage stats for your current key (calls, minutes, leads, top agents) plus recent calls with one-tap redial.
- **Call recording**: every call is recorded on your device (agent + your mic mixed). A red dot shows it's recording; after hangup, download or delete the audio from the call's detail view. Recordings never leave your device, and old ones auto-delete after your retention window.
- **Auto call summaries**: after each call, a short AI summary (3–4 lines + outcome) is generated and saved with the call record and memory — fire-and-forget, never blocks the call.
- **Auto-cleanup**: recordings, call records, and memory transcripts older than N days are pruned automatically (Settings → Data retention, default 30; server uses `RETENTION_DAYS`).
- **Persistent memory**: set `DATA_DIR` to keep call history and memories across redeploys (e.g. a Railway volume), plus one-click **Download backup (JSON)** / **Restore from backup** on the Memory page.
- **Rate limiting, usage & audit**: 3 concurrent calls per key max; per-key usage at `/api/v7/key/usage`; audit log at `/api/v7/audit`.

## Persistent data on hosting (Railway)

By default history and memories live in `./data` — on Railway the filesystem is wiped on every redeploy, so set a persistent volume:

1. Railway dashboard → your service → **Volumes** → **Add volume**, mount path `/data`.
2. Same service → **Variables** → add `DATA_DIR=/data`.
3. Redeploy. History, memories, custom agents, and key profiles now survive updates.

**Auto-deploy:** Railway redeploys on every push to your connected GitHub branch — no manual redeploy step. The data dir is **not** wiped by a code push, only by the volume being absent.

Tip: before any big change, use **Memory → Download backup (JSON)** to keep a local copy; **Restore from backup** puts it back (restores into your current key's scope).

## API reference (v7)

The client identifies with the `x-key-hash` header (sha256 hex of the API key) or `?keyHash=` — the raw key is never sent to REST routes. Without a valid hash, keyed routes return `400`; the key-gated routes (`/api/v7/key/*`, `/api/v7/audit`) return `401`.

| Method & path | Purpose |
|---|---|
| `GET /api/agents` | 101 built-in agents |
| `GET /api/history` · `DELETE /api/history` | call history (this key's partition) |
| `POST /api/history/:id/summary` | save auto-summary |
| `POST /api/v7/calls/:id/notes` | in-call notes |
| `GET /api/memories` · `DELETE /api/memories` | memories (this key's partition) |
| `GET /api/memories/:id` · `DELETE /api/memories/:id` | one memory |
| `POST /api/restore` | backup restore (into this key's scope) |
| `GET /api/stats` | dashboard stats |
| `GET /api/v7/key/profiles` · `POST` · `DELETE /api/v7/key/profiles/:keyHash` | key profiles |
| `GET /api/v7/key/usage` | calls + minutes for this key |
| `GET /api/v7/audit` | recent server audit entries |
| `GET /api/v7/custom-agents` · `POST` | list / create custom agents |
| `GET /api/v7/custom-agents/:id` · `PUT` · `DELETE` | one custom agent |
| `POST /api/v7/custom-agents/clone` | `{ sourceId }` → pre-filled draft |
| `GET /api/v7/custom-agents/:id/avatar` | uploaded avatar JPEG |

## How it works

```
browser ──WS /live──▶ server ──SDK──▶ Google Gemini Live
   │                     │
   │                     ├── one Live session per call (agent's voice + prompt)
   │                     ├── key in memory only for the call, cleared on hangup
   │                     ├── rate limit: 3 concurrent calls per key
   │                     └── DATA_DIR/calls_<keyHash>.json, memories_<keyHash>.json,
   │                         custom_<keyHash>.json (per-key partitions)
```

- Official `@google/genai` SDK, server-side. The browser never talks to Google; the raw key travels only inside the WebSocket `setup` message (never in a URL or REST header).
- Model order (configurable): `gemini-3.8-live` → `gemini-3.1-flash-live-preview` → `gemini-3.8-live-extended-thinking` (last resort). Slow reconnect backoff, no retry storms.
- Mic: AudioWorklet capture, linear resampling to 16 kHz PCM (tested at 44.1/48 kHz), silence frames dropped to save quota. The mic stays gated until the greeting audio lands (or a 10s fallback) — a live mic from second zero makes the Live API's voice-activity detection hold back its first reply.
- Playback: gapless scheduling, output sample rate parsed from the audio MIME type, clean stop on interruption/hangup.
- Exactly one greeting trigger per fresh session (none after resume), at most one retry; sessions close on hangup (no quota drain).

## Tests

```bash
npm test
```

**251 tests, zero dependencies**: agent directory (101 unique fictional numbers, gender↔voice mapping, voice-identity prompt lines, safety prompts, no prompt/knowledge leakage), SymAgent (company knowledge, 100-agent directory, share_links emits official URLs only), history logging, memory store (lifecycle, recall, key-scoped partitions, key never stored), the search provider chain (stubbed, no network), the dial/call protocol against a fake SDK (number resolution, NO_SUCH_NUMBER / NO_KEY, single greeting, watchdog nudge, chat turn-completion, DTMF isolation, save_note → memory, end_call → agent hangup, recall injection, per-key isolation instead of wipe), the audio resampler, transfer_call (SymAgent-gated tool, id/number resolution incl. custom-agent fallback, self/unknown rejection, bridge transfer + call_id events, prompt section), persistence (DATA_DIR isolation, importAll replace, setSummary), stats aggregation (totals, top-5, SymAgent lead count), the call recorder state machine (stubbed MediaRecorder; real audio capture is browser-only), the summary module (prompt shape, null-safe skip behavior, key never in URL), live HTTP integration for /api/stats, /api/restore and the summary endpoint (real server on a test port), and the v7 workstreams:

- **WS1 key gating**: keystore (profiles, usage metering, rate limiter, audit), per-keyHash store partitions, keygate REST routes, KeyGate client (login overlay, apiFetch, switcher) with a DOM shim.
- **WS2 custom agents**: validation, store CRUD, avatar upload, clone drafts, `toAgent` shape, REST routes, client merge helpers.
- **WS3 greeting fix**: pure handshake helpers (trigger/retry text, output classification), greeting-state machine, client diag timeline.
- **WS4 directory UX**: filterAgents, swipe extraction, per-agent stats aggregation, profileSheet/toolbar renderers (DOM-shimmed).
- **WS5 call experience**: notes save, transcript text builder, transcript search, bubble/meter/quota/recents, keyHash helper, notes route.
- **WS6 docs**: docs.html structure, anchors, back-link, integrator contract.
- **WS7 hygiene + integration**: retention pruning (server `pruneOlderThan`/`pruneAll`, client IndexedDB prune), accent picker, history filters, bridge rate limiting + usage + audit + custom_ resolution + per-key partitions, live.js transfer fallback (custom agents), SymAgent prompt directory section, and live server mounts (keygate 401/400, custom-agents 400, notes 404).

## Verified / not verified

**Verified:** install, dev server, 101-agent API, directory/dialer/phone UI, dial-by-number, unknown-number and missing-key handling, call-history logging, key-gated login + profiles, custom-agent create/list/clone/avatar flow (HTTP-level), rate limiting + usage + audit, per-key data isolation, retention pruning (server + store level), accent/history-filter pure logic, greeting-state → overlay mapping (code-wired), all 251 tests, fresh-zip install + test.

**Needs your real-key testing (browser-only / live):** the actual greeting behavior on a real call (handshake timings are engineering estimates until measured), call recording audio quality, the login overlay + key switcher UX, the floating bubble on mobile, swipe gestures on touch devices, custom-agent voice calls end-to-end, and in-call notes rendering.

## Notes & limits

- **Vercel, explained simply:** Vercel runs *serverless* functions — tiny programs that wake up, answer once, and sleep. A voice call needs the opposite: one *permanent open line* held the whole call (browser → server → Google, via WebSocket). Vercel cannot hold that line open. So: the website's *look* can live on Vercel later, but `server.js` (the relay that holds calls open) must run 24/7 on an always-on host (a VPS, Render, or Fly.io — a few dollars a month). The code is already split for exactly this.
- Local demo: not a real phone network, not an emergency service, not a medical/legal/financial provider.
- Built independently with the official Google SDK (clean-room; no third-party code copied).
