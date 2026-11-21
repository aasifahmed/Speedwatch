const $ = (s) => document.querySelector(s);

const ALARM = "speedTest";
const DEFAULT_INTERVAL_MIN = 3;
const SPAN_MS = 2 * 60 * 60 * 1000;
const STALE_RUN_MS = 60_000;
const USAGE_FRESH_MS = 4000;

const TIERS = [
  { max: 5, color: "#FF6B6B", text: "Slow. Pages may stall and video will buffer." },
  { max: 25, color: "#FFB547", text: "Okay for browsing and video calls." },
  { max: 100, color: "#3DDC97", text: "Fast. HD and 4K streaming run smoothly." },
  { max: Infinity, color: "#5CE1E6", text: "Very fast. Large downloads finish in seconds." },
];
const tierOf = (m) => TIERS.find((t) => m < t.max);

const state = { history: [], runningSince: 0, nextAt: null, usage: null, interval: DEFAULT_INTERVAL_MIN };
const periodMs = () => state.interval * 60 * 1000;

/* ---------- Formatting ---------- */

const fmt = (m) => (m >= 100 ? m.toFixed(0) : m.toFixed(1));
const bytesParts = (n) => {
  const K = 1024;
  const pick = (v, d) => (v >= 100 ? v.toFixed(0) : v.toFixed(d));
  if (n < K) return { v: String(Math.round(n)), u: "B" };
  if (n < K * K) return { v: pick(n / K, 1), u: "KB" };
  if (n < K ** 3) return { v: pick(n / K / K, 2), u: "MB" };
  return { v: (n / K ** 3).toFixed(2), u: "GB" };
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const clockFull = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const isRunning = () => state.runningSince && Date.now() - state.runningSince < STALE_RUN_MS;
const lastTest = () => state.history.at(-1) ?? null;
const lastOk = () => [...state.history].reverse().find((h) => h.ok) ?? null;

/* ---------- Data ---------- */

async function load() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["history", "runningSince", "intervalMin"]),
    chrome.storage.session.get("usage"),
  ]);
  const cutoff = Date.now() - SPAN_MS;
  state.history = (local.history ?? []).filter((h) => h.time >= cutoff);
  state.runningSince = local.runningSince ?? 0;
  const n = Number(local.intervalMin);
  state.interval = Number.isInteger(n) && n >= 1 ? n : DEFAULT_INTERVAL_MIN;
  state.usage = session.usage ?? null;
  await refreshAlarm();
  render();
}

async function refreshAlarm() {
  const a = await chrome.alarms.get(ALARM);
  state.nextAt = a?.scheduledTime ?? null;
}

/* ---------- Hero ---------- */

function renderHero() {
  const hero = $("#hero");
  const fresh = state.usage && Date.now() - state.usage.time < USAGE_FRESH_MS;
  const running = isRunning();

  $("#live").classList.toggle("is-on", !!fresh);
  $("#live-label").textContent = fresh ? "Live" : "Idle";
  hero.style.setProperty("--tier", "#8FB0FF");

  if (fresh) {
    const r = bytesParts(state.usage.rate);
    $("#usage").textContent = r.v;
    $("#usage-unit").textContent = `${r.u}/s`;
    const t = bytesParts(state.usage.total);
    $("#verdict").textContent = `Used today: ${t.v} ${t.u}`;
  } else {
    $("#usage").textContent = "–";
    $("#usage-unit").textContent = "KB/s";
    $("#verdict").textContent = "Waiting for usage data.";
  }

  // Latest speed check, shown above the chart
  const test = lastTest();
  const el = $("#sec-val");
  if (running) {
    el.textContent = "Checking…";
    el.style.color = "";
  } else if (!test) {
    el.textContent = "–";
    el.style.color = "";
  } else if (!test.ok) {
    el.textContent = "Offline";
    el.style.color = "#FF6B6B";
  } else {
    el.textContent = `${fmt(test.mbps)} Mbps`;
    el.style.color = tierOf(test.mbps).color;
  }
}

/* ---------- Render ---------- */

function render() {
  renderHero();
  renderStats();
  renderChart();
  tick();
}

function renderStats() {
  const ok = state.history.filter((h) => h.ok);
  const unit = "<small>Mbps</small>";
  if (!ok.length) {
    ["#s-avg", "#s-max", "#s-min"].forEach((s) => ($(s).textContent = "–"));
  } else {
    const v = ok.map((h) => h.mbps);
    $("#s-avg").innerHTML = fmt(v.reduce((a, b) => a + b, 0) / v.length) + unit;
    $("#s-max").innerHTML = fmt(Math.max(...v)) + unit;
    $("#s-min").innerHTML = fmt(Math.min(...v)) + unit;
  }
  const l = lastOk();
  $("#s-ping").innerHTML = l ? `${Math.round(l.latency)}<small>ms</small>` : "–";
}

/* ---------- Per-second tick ---------- */

let tickCount = 0;
function tick() {
  tickCount++;
  const running = isRunning();

  const btn = $("#test");
  btn.disabled = running;
  btn.textContent = running ? "Testing…" : "Test now";

  const test = lastTest();
  $("#last-time").textContent = test ? clock(test.time) : "–";
  $("#last-ago").textContent = test ? ago(test.time) : "No checks yet";

  if (state.nextAt) {
    const remaining = state.nextAt - Date.now();
    if (remaining < -2000) refreshAlarm();
    $("#next-time").textContent = clock(state.nextAt);
    $("#next-in").textContent = running ? "Running now" : remaining > 0 ? `in ${mmss(remaining)}` : "Starting…";
    const frac = Math.min(1, Math.max(0, 1 - remaining / periodMs()));
    $("#track").style.width = `${frac * 100}%`;
  } else {
    $("#next-time").textContent = "–";
    $("#next-in").textContent = "";
    $("#track").style.width = "0";
  }

  renderHero();
  const input = $("#minutes");
  if (document.activeElement !== input && input.value === "") input.value = String(state.interval);
  if (tickCount % 20 === 0) renderChart(); // slide the 2-hour window
}

/* ---------- Chart: one vertical bar per check ---------- */

const W = 348, H = 84, PAD = { l: 2, r: 30, t: 8, b: 18 };
const BASE = H - PAD.b;
let model = null;

function niceMax(v) {
  const target = Math.max(v * 1.12, 5);
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  return [1, 2, 5, 10].map((k) => k * mag).find((n) => n >= target);
}

function renderChart() {
  const now = Date.now();
  const t0 = now - SPAN_MS;
  const inRange = state.history.filter((h) => h.time >= t0);
  const ok = inRange.filter((h) => h.ok);
  hideHover();

  const plotW = W - PAD.l - PAD.r;
  let out = `<line class="grid" x1="${PAD.l}" x2="${PAD.l + plotW}" y1="${BASE}" y2="${BASE}"/>`;

  if (!ok.length) {
    model = null;
    out += `<text class="empty" x="${PAD.l + plotW / 2}" y="${H / 2 - 6}">No checks in the last 2 hours yet</text>`;
    $("#plot").innerHTML = out;
    return;
  }

  const maxV = niceMax(Math.max(...ok.map((p) => p.mbps)));
  const x = (t) => PAD.l + ((t - t0) / SPAN_MS) * plotW;
  const barH = (v) => Math.max(2, (v / maxV) * (BASE - PAD.t));
  const slotW = (plotW * periodMs()) / SPAN_MS;
  const barW = Math.max(2, Math.min(10, slotW * 0.68));
  const clampX = (cx) => Math.min(PAD.l + plotW - barW, Math.max(PAD.l, cx - barW / 2));

  out += `<line class="grid" x1="${PAD.l}" x2="${PAD.l + plotW}" y1="${PAD.t}" y2="${PAD.t}"/>`;
  out += `<text class="axis axis-end" x="${W}" y="${PAD.t + 3.5}">${fmt(maxV)}</text>`;
  out += `<text class="axis axis-end" x="${W}" y="${BASE + 3.5}">0</text>`;
  out += `<text class="axis" x="${PAD.l}" y="${H - 3}">2h ago</text>`;
  out += `<text class="axis" x="${PAD.l + plotW / 2}" y="${H - 3}" text-anchor="middle">1h ago</text>`;
  out += `<text class="axis axis-end" x="${PAD.l + plotW}" y="${H - 3}">Now</text>`;

  const items = [];
  ok.forEach((p) => {
    const bh = barH(p.mbps);
    const bx = clampX(x(p.time));
    out += `<rect x="${bx.toFixed(2)}" y="${(BASE - bh).toFixed(2)}" width="${barW.toFixed(2)}" height="${bh.toFixed(2)}" rx="${Math.min(2, barW / 2)}" fill="${tierOf(p.mbps).color}"/>`;
    items.push({ p, cx: bx + barW / 2 });
  });

  // Failed checks sit on the baseline as short red bars
  inRange.filter((h) => !h.ok).forEach((f) => {
    out += `<rect x="${clampX(x(f.time)).toFixed(2)}" y="${BASE - 6}" width="${barW.toFixed(2)}" height="6" rx="1" fill="#FF6B6B"/>`;
  });

  $("#plot").innerHTML = out;
  model = { items, barW };
}

$("#hit").addEventListener("mousemove", (e) => {
  if (!model) return;
  const rect = $("#svg").getBoundingClientRect();
  const vx = ((e.clientX - rect.left) / rect.width) * W;
  let best = null, bestD = Infinity;
  for (const it of model.items) {
    const d = Math.abs(it.cx - vx);
    if (d < bestD) { best = it; bestD = d; }
  }
  if (!best || bestD > Math.max(10, model.barW)) return hideHover();

  const bar = $("#hv-bar");
  bar.setAttribute("x", best.cx - model.barW / 2 - 2);
  bar.setAttribute("width", model.barW + 4);
  bar.style.display = "";

  $("#tip-val").textContent = `${fmt(best.p.mbps)} Mbps`;
  $("#tip-time").textContent = clockFull(best.p.time);
  const tip = $("#tip");
  tip.hidden = false;
  const scale = rect.width / W;
  tip.style.left = `${Math.min(rect.width - 44, Math.max(44, best.cx * scale))}px`;
  tip.style.top = "-44px";
});

function hideHover() {
  $("#hv-bar").style.display = "none";
  $("#tip").hidden = true;
}
$("#hit").addEventListener("mouseleave", hideHover);

/* ---------- Controls + updates ---------- */

$("#test").addEventListener("click", () => {
  state.runningSince = Date.now();
  render();
  chrome.runtime.sendMessage({ type: "run-test" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    if (changes.usage) {
      state.usage = changes.usage.newValue ?? null;
      renderHero();
    }
    return;
  }
  // The background saves running usage totals now and then; nothing here depends on them
  if (Object.keys(changes).every((k) => k === "usage")) return;
  load();
});

/* ---------- Interval setting ---------- */

const minutes = $("#minutes");
const msg = $("#msg");

function say(text, isError = false) {
  msg.textContent = text;
  msg.classList.toggle("err", isError);
  minutes.setAttribute("aria-invalid", String(isError));
}

minutes.addEventListener("input", () => {
  minutes.value = minutes.value.replace(/\D/g, ""); // digits only
  say("");
});

$("#interval").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = minutes.value.trim();
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > 1440) {
    say("Enter a whole number of minutes, from 1 to 1440.", true);
    return;
  }
  await chrome.storage.local.set({ intervalMin: n });
  state.interval = n;
  say(`Saved. Checking every ${n} ${n === 1 ? "minute" : "minutes"}.`);
  await new Promise((r) => setTimeout(r, 300)); // let the background reschedule
  await refreshAlarm();
  renderChart();
  tick();
});

setInterval(tick, 1000);
load().then(() => {
  minutes.value = String(state.interval);
});
