# v6.0.0 real-call test checklist

Run these on https://symbiotecalling-production.up.railway.app with your own API key.
Do the Railway volume step (backup → volume at /data → DATA_DIR=/data → restore) before
heavy testing, or a redeploy wipes everything you collect here.

## 1. Transfer (SymAgent only)
- Call SymAgent (+1 (555) 010-0101) and say: "connect me to your visa consultant"
- SymAgent should confirm first (it may transfer only after you say yes), say one brief
  handoff sentence, then connect you.
- Expected landing: **Chloe — Visa Info Guide, +1 (555) 010-0039**.
- Watch for: double greeting after transfer, or transfer firing without confirmation.

## 2. Call recording
- Make a normal call (any agent), talk for ~1 minute, hang up.
- Open History → the call entry → download the recording, play it back.
- Watch for: missing/empty file, cut-off start or end, muffled audio.

## 3. Auto-summary
- Same call: open its History entry and read the auto-summary.
- Watch for: summary missing, wrong facts, or mentioning the wrong agent.

## 4. Dashboard
- Open the dashboard and confirm your test calls show up in the stats
  (totals and per-agent counts look right).

## Report back
For each: pass / fail + what exactly went wrong (one line is enough).
