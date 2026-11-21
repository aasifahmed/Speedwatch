// A once-per-second metronome. It lives in a Worker because timers in hidden
// pages can be throttled, while worker timers keep their pace.
let next = performance.now() + 1000;
(function loop() {
  setTimeout(() => {
    self.postMessage({ type: "tick" });
    next += 1000;
    loop();
  }, Math.max(0, next - performance.now()));
})();
