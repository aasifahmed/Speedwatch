// Hidden page that hosts the ticker worker and forwards each tick to the background worker.
const worker = new Worker("ticker-worker.js");
worker.onmessage = () => {
  chrome.runtime.sendMessage({ type: "tick" }).catch(() => {});
};
