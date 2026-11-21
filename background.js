// Speedwatch background service worker (Manifest V3)

const ALARM = "speedTest";
const DEFAULT_INTERVAL_MIN = 3;
const HISTORY_MS = 2 * 60 * 60 * 1000; // keep 2 hours of speed checks
const STALE_RUN_MS = 60_000;

const TEST_URL = "https://speed.cloudflare.com/__down";
const PROBE_BYTES = 1_000_000;
const MIN_BYTES = 2_000_000;
const MAX_BYTES = 20_000_000; // caps data use per speed check
const TARGET_SECONDS = 3;

const K = 1024;

/* ---------- Setup ---------- */

async function getInterval() {
  const { intervalMin } = await chrome.storage.local.get("intervalMin");
  const n = Number(intervalMin);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : DEFAULT_INTERVAL_MIN;
}

async function ensureAlarm(force = false) {
  const period = await getInterval();
  const existing = await chrome.alarms.get(ALARM);
  if (force || !existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
}

let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Runs a once-per-second timer for the live data-usage badge.",
      })
      .finally(() => (creating = null));
  }
  await creating;
}

async function boot(runNow) {
  await ensureAlarm();
  await ensureOffscreen();
  if (runNow) runTest();
}

chrome.runtime.onInstalled.addListener(() => boot(true));
chrome.runtime.onStartup.addListener(() => boot(true));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  await ensureOffscreen();
  runTest();
});

// The panel changed the check interval: restart the schedule from now
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.intervalMin) ensureAlarm(true);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tick") {
    handleTick();
  } else if (msg?.type === "run-test") {
    runTest().then(() => sendResponse({ ok: true }));
    return true;
  }
});

boot(false);

/* ---------- Data usage (every second) ---------- */

// Chrome can't report whole-device traffic, so this adds up the size of every
// response the browser finishes downloading (from its Content-Length header).
// Speedwatch's own speed checks are left out.
let pending = 0; // bytes finished since the last tick
const recent = []; // last few seconds, for a steadier reading
let usage = null; // { day, total }
let ticks = 0;

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.fromCache) return;
    if (d.initiator && d.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) return;
    const header = d.responseHeaders?.find((h) => h.name.toLowerCase() === "content-length");
    const n = header ? parseInt(header.value, 10) : 0;
    if (n > 0) pending += n;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

async function loadUsage() {
  if (!usage) {
    const { usage: saved } = await chrome.storage.local.get("usage");
    usage = saved && saved.day === today() ? saved : { day: today(), total: 0 };
  }
  if (usage.day !== today()) usage = { day: today(), total: 0 };
}

async function handleTick() {
  const bytes = pending;
  pending = 0;
  await loadUsage();
  usage.total += bytes;

  recent.push(bytes);
  if (recent.length > 3) recent.shift();
  const rate = recent.reduce((a, b) => a + b, 0) / recent.length;

  setUsageBadge(rate);
  chrome.storage.session.set({ usage: { rate, total: usage.total, day: usage.day, time: Date.now() } });

  if (++ticks % 30 === 0) chrome.storage.local.set({ usage });
}

function badgeText(bps) {
  if (bps < 1) return "0";
  if (bps < K) return "<1K";
  const kb = Math.round(bps / K);
  if (kb < 1000) return `${kb}K`;
  const mb = bps / K / K;
  return mb >= 10 ? `${Math.round(mb)}M` : `${mb.toFixed(1)}M`;
}

function setUsageBadge(bps) {
  chrome.action.setBadgeText({ text: badgeText(bps) });
  chrome.action.setBadgeBackgroundColor({ color: bps >= 1 ? "#2F5BFF" : "#5B6783" });
  chrome.action.setBadgeTextColor?.({ color: "#FFFFFF" });
}

/* ---------- Speed check (on the chosen interval) ---------- */

async function measureLatency(samples = 6) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${TEST_URL}?bytes=0&_=${Date.now()}${i}`, { cache: "no-store" });
      await res.arrayBuffer();
      times.push(performance.now() - t0);
    } catch {
      /* skip failed sample */
    }
  }
  if (!times.length) throw new Error("Couldn't reach the test server");
  const usable = times.length > 2 ? times.slice(1) : times; // first request includes the TLS handshake
  usable.sort((a, b) => a - b);
  return usable[Math.floor(usable.length / 2)];
}

// Times the transfer from the first byte onward, so latency doesn't skew throughput
async function measureDownload(bytes, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let received = 0;
  let tFirst = 0;
  let tEnd = 0;

  try {
    const res = await fetch(`${TEST_URL}?bytes=${bytes}&_=${Date.now()}`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Test server returned ${res.status}`);

    const reader = res.body.getReader();
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        tFirst = performance.now();
        first = false;
        continue;
      }
      received += value.length;
      tEnd = performance.now();
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }

  const seconds = (tEnd - tFirst) / 1000;
  if (received === 0 || seconds <= 0) throw new Error("Couldn't reach the test server");
  return { mbps: (received * 8) / seconds / 1e6, bytes: received };
}

async function measureSpeed() {
  const probe = await measureDownload(PROBE_BYTES, 8000);
  if (probe.mbps < 2) return probe.mbps;

  const bytes = Math.min(
    MAX_BYTES,
    Math.max(MIN_BYTES, Math.round(((probe.mbps * 1e6) / 8) * TARGET_SECONDS))
  );
  const main = await measureDownload(bytes, 15000);
  return main.mbps;
}

async function runTest() {
  const { runningSince } = await chrome.storage.local.get("runningSince");
  if (runningSince && Date.now() - runningSince < STALE_RUN_MS) return;

  await chrome.storage.local.set({ runningSince: Date.now() });

  let entry;
  try {
    const latency = await measureLatency();
    const mbps = await measureSpeed();
    entry = { time: Date.now(), ok: true, mbps, latency };
  } catch (err) {
    entry = { time: Date.now(), ok: false, error: err.message || "Offline" };
  }

  const cutoff = Date.now() - HISTORY_MS;
  const { history = [] } = await chrome.storage.local.get("history");
  history.push(entry);
  await chrome.storage.local.set({
    history: history.filter((h) => h.time >= cutoff),
    runningSince: 0,
  });

  const time = new Date(entry.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  chrome.action.setTitle({
    title: entry.ok
      ? `Speedwatch\nLast check ${time}: ${entry.mbps.toFixed(1)} Mbps, ping ${Math.round(entry.latency)} ms`
      : `Speedwatch\nLast check ${time}: offline`,
  });
}
