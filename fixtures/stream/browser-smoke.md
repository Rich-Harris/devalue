# Browser CSP smoke fixture

Run the finite stream and abandonment smoke test with an already-installed Google Chrome:

```sh
node fixtures/stream/run-browser-csp-smoke.mjs
```

The runner defaults to the standard macOS Google Chrome path. Set `CHROME_PATH` to another installed Chrome or Chromium executable on macOS or Linux. It creates a unique profile beneath the directory selected by Node's `os.tmpdir()` (including `TMPDIR`), uses Chrome's ephemeral debugging endpoint, and removes only that profile and processes it started.

`DEVALUE_BROWSER_NAVIGATION_DELAY_MS=150` (accepted range 0–5,000 ms) delays abandonment-marker inspection to stress navigation scheduling. The default is zero. Missing browsers, early exits, CDP disconnections, and watchdog expiry are reported as nonzero failures; the runner does not install or silently skip a browser.

Harness tests can opt a controlled fake browser into separate setup and readiness handshakes with `DEVALUE_BROWSER_TEST_SETUP_FILE` and `DEVALUE_BROWSER_TEST_READY_FILE`; each file must contain the spawned child's positive integer PID. `DEVALUE_BROWSER_TEST_SETUP_TIMEOUT_MS` and `DEVALUE_BROWSER_TEST_READINESS_TIMEOUT_MS` independently bound those phases and default to 5,000 ms. Tests can request a final parent-owned process snapshot with `DEVALUE_BROWSER_TEST_PROCESS_FILE`; it records the spawned PID and observed exit code/signal after cleanup. Real Chrome startup uses none of these test-only hooks, and its DevTools endpoint deadline begins immediately after launch as before.

The server delivers hydration source only through nonce-bearing classic script elements under restrictive CSP. CDP reads results and controls navigation but does not execute the hydration source.
