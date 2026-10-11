# Symbiote Calling

Dial 101 AI calling agents from a phone-style UI, powered by Gemini Live. Each agent has its own fictional number — pick from the directory or punch it into the dialer, and a phone UI opens with a live voice call, timer, keypad, and chat. Agents remember you: every call saves notes, appointments, and a transcript to the Memory page, and agents recall past calls when you ring again.

Local demo for now (`npm install && npm run dev` → http://localhost:3000). Built to scale to 100+: adding an agent is one entry in `src/agents.js`.

## Quick start

```bash
npm install
npm run dev
```

1. Open **Settings** first: paste **one** Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey)) — it applies to all 100 agents. Kept in server memory for the call only; never stored, never logged, never in a URL. (Or set `GEMINI_API_KEY` in a `.env` file — see `.env.example`.)
2. **Agents** tab → tap Call on anyone, e.g. Ava `+1 (555) 010-0001`.
3. Or open the **Dialer**, punch in a number, hit call.
4. The phone UI opens: *Dialing… → Connecting… → live timer (mm:ss)*, mute, keypad (real DTMF tones), chat (type → agent answers by voice), hang up. Say "cut the call" / "khuda hafiz" and the agent says goodbye and hangs up itself.
5. **History** tab logs every call (agent, number, time, duration — metadata only).
6. **Memory** tab: every call is saved with the agent's notes (appointments, facts) and the full transcript. Open any memory for details. Call the same agent again and it remembers your past calls.

> Mic permission is requested only when a call starts (toggleable in Settings). If the mic is unavailable, the call continues in chat mode — the agent still answers by voice.

## SymAgent — the 101st agent (company representative)

**SymAgent** (`+1 (555) 010-0101`) sits in a featured hero card above the agent directory. It's the official AI representative of **Symbiote Systems** — the agency behind this platform. It knows:

- **The company**: services (AI calling/voice agents, websites, AI chatbots, AI automation on Make/n8n), portfolio, socials, and contact (email + WhatsApp).
- **All 100 calling agents**: a compact directory of every agent (name, niche, number) is injected into its prompt, generated from `src/agents.js` so it never drifts — it can explain what each agent does and why the platform was built.
- **The rules**: no pricing talk, no appointment booking — it informs, impresses, and captures leads. When a caller is interested, it collects name, email, phone, and the service they want, then saves it via `save_note` so the team can follow up.

New `share_links` tool (SymAgent only): when a caller asks for socials, portfolio, or contact details, the agent drops **clickable link chips** into the in-call chat — Instagram, Threads, X, LinkedIn, Pinterest, Gumroad, portfolio sites, client work (Aquifer Reach LLC), email, WhatsApp. URLs are server-side constants, so the model can never invent or inject its own links.

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

- **Greeting that actually arrives**: the call sends a greeting trigger on connect; if the model stays silent, a one-time watchdog nudge fires. The playback audio context is created inside your tap (no autoplay block).
- **Real-time web search**: every agent has the `web_search` tool — a 4-provider chain (DuckDuckGo instant answers → Wikipedia → Google News RSS for real-time news → DDG web results), per-provider breakers and 10s timeouts so one slow provider can't kill search. Ask about current prices, news, hours, schedules.
- **Agent hangup**: say "cut the call" / "khuda hafiz" / goodbye — the agent says farewell and ends the call itself (`end_call` tool, 4s grace for the goodbye audio).
- **100 AI portraits**: every agent has its own AI-generated face-portrait avatar (face only, no letters) — with a procedural SVG fallback if a photo is ever missing. Deploy note: the GitHub repo stores avatars as base64 sidecars (`public/avatars/<id>.jpg.b64`) because the push tooling is text-only; `server.js` decodes and serves them as real JPEGs automatically.
- **SymAgent hero + clickable links**: the 101st agent gets a featured hero card; its `share_links` tool drops clickable social/portfolio/contact chips into the in-call chat.
- **Subtle motion & SFX**: cards rise in with a stagger, the phone slides up, buttons press-scale, the avatar pulses while speaking — plus tiny WebAudio blips for tap, connect, hangup, and messages.
- **Smart dialer**: start typing a number and matching agents appear above the pad, phone-style; exact matches highlighted, no match shows nothing.
- **Memory**: every call auto-saves notes (appointments, facts the agent records via `save_note`), plus the full transcript. The Memory page shows per-call details; calling the same agent again injects its recent memories into the prompt so it remembers you.
- **Key-scoped data**: memories + history are tied to your API key (by hash — the key is never stored). Change the key and everything resets, so keys never cross-contaminate.
- **Light/dark themes**: warm light default (easy on the eyes), one-tap dark mode, remembered.
- **In-call chat** with a close button; **DTMF keypad** with real tones (tones never reach the model).
- **Call history** with durations and one-tap call-back.

## How it works

```
browser ──WS /live──▶ localhost server ──SDK──▶ Google Gemini Live
   │                        │
   │                        ├── one Live session per call (agent's voice + prompt)
   │                        ├── key in memory only, cleared on hangup
   │                        └── data/calls.json: call history (metadata only)
```

- Official `@google/genai` SDK, server-side. The browser never talks to Google; the key never leaves the setup message.
- Model order (configurable): `gemini-3.8-live` → `gemini-3.1-flash-live-preview` → `gemini-3.8-live-extended-thinking` (last resort). Slow reconnect backoff, no retry storms.
- Mic: AudioWorklet capture, linear resampling to 16 kHz PCM (tested at 44.1/48 kHz), silence frames dropped to save quota.
- Playback: gapless scheduling, output sample rate parsed from the audio MIME type, clean stop on interruption/hangup.
- Exactly one setup confirmation and one greeting per call; sessions close on hangup (no quota drain).

## Tests

```bash
npm test
```

50 tests, zero dependencies: agent directory (101 unique fictional numbers, gender↔voice mapping, voice-identity prompt lines, safety prompts, no prompt/knowledge leakage), SymAgent (company knowledge, 100-agent directory, share_links emits official URLs only), history logging, memory store (lifecycle, recall, key-scoped wipe, key never stored), the search provider chain (stubbed, no network), the dial/call protocol against a fake SDK (number resolution, NO_SUCH_NUMBER / NO_KEY, single greeting, watchdog nudge, chat turn-completion, DTMF isolation, save_note → memory, end_call → agent hangup, recall injection, key-change reset), and the audio resampler.

## Verified / not verified

**Verified:** install, dev server, 50-agent API, directory/dialer/phone UI, dial-by-number, unknown-number and missing-key handling, call-history logging, all 27 tests, fresh-zip install + test.

**Live voice path:** the session engine is the same module already proven 100% working with a real key; per-call wiring is covered by protocol tests. The greeting fix (trigger + watchdog + gesture-time audio) is tested at protocol level — please confirm on a real call that the agent now greets first.

## Notes & limits

- **Vercel, explained simply:** Vercel runs *serverless* functions — tiny programs that wake up, answer once, and sleep. A voice call needs the opposite: one *permanent open line* held the whole call (browser → server → Google, via WebSocket). Vercel cannot hold that line open. So: the website's *look* can live on Vercel later, but `server.js` (the relay that holds calls open) must run 24/7 on an always-on host (a VPS, Render, or Fly.io — a few dollars a month). The code is already split for exactly this.
- Local demo: not a real phone network, not an emergency service, not a medical/legal/financial provider.
- Built independently with the official Google SDK (clean-room; no third-party code copied).
