/**
 * Load test: 100 POST /api/events requests with valid HMAC signatures.
 *
 * Two modes:
 *   --concurrent  (default) Fire all 100 at the same instant. Validates that the server
 *                 accepts 100 simultaneous connections. Latencies look artificially low
 *                 because requests are co-scheduled in a single Node.js tick and share
 *                 the same connection pool.
 *
 *   --batched     Fire in batches of 10 requests every BATCH_INTERVAL_MS (default 50ms).
 *                 Each batch starts after the previous interval, not after the previous
 *                 batch completes, so load is continuous rather than bursty. This gives
 *                 a more honest per-request latency measurement because requests are not
 *                 all hitting the OS TCP backlog at the same millisecond.
 *
 * Usage:
 *   WEBHOOK_SECRET=your-secret node scripts/load-test.mjs
 *   WEBHOOK_SECRET=your-secret node scripts/load-test.mjs --batched
 *   WEBHOOK_SECRET=your-secret ROUTING_FAILURE_RATE=0 node scripts/load-test.mjs
 *
 * Note: set ROUTING_FAILURE_RATE=0 in your .env when running the load test if you want
 * "ALL 100 ACCEPTED" — the default 20% failure rate means ~49% of events will exhaust
 * retries and end up in the DLQ (correct behaviour, but noisy output for a demo).
 */

import crypto from 'crypto';
import http from 'http';

const HOST = process.env.HOST ?? 'localhost';
const PORT = process.env.PORT ?? 3000;
const SECRET = process.env.WEBHOOK_SECRET;
const API_KEY = process.env.API_KEY;
const TOTAL = 100;

// End-to-end verification: poll GET /api/events/:id until all events reach a terminal state.
// Enable with --verify flag (requires API_KEY to be set).
const VERIFY_E2E = process.argv.includes('--verify');

if (!SECRET) {
  console.error(
    '\nERROR: WEBHOOK_SECRET is not set.\n' +
    'Every request will fail with 401. Set the secret before running:\n\n' +
    '  WEBHOOK_SECRET=your-secret node scripts/load-test.mjs          # Linux/macOS\n' +
    '  $env:WEBHOOK_SECRET="your-secret"; node scripts/load-test.mjs  # PowerShell\n'
  );
  process.exit(1);
}
const BATCH_SIZE = 10;
const BATCH_INTERVAL_MS = 50;

const BATCHED_MODE = process.argv.includes('--batched');

// Shipment IDs seeded in the DB (ship-1 to ship-10)
const SHIPMENT_IDS = Array.from({ length: 10 }, (_, i) => `ship-${i + 1}`);
const EVENT_TYPES = ['shipment.status_updated', 'shipment.departed', 'payment.confirmed'];
const SOURCES = ['fedex', 'ups', 'dhl'];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPayload(index) {
  return {
    eventId: crypto.randomUUID(),
    type: randomItem(EVENT_TYPES),
    source: randomItem(SOURCES),
    timestamp: new Date().toISOString(),
    payload: {
      shipmentId: SHIPMENT_IDS[index % SHIPMENT_IDS.length],
    },
  };
}

function sign(bodyStr) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(bodyStr);
  return `sha256=${hmac.digest('hex')}`;
}

function sendRequest(index) {
  return new Promise((resolve) => {
    const body = buildPayload(index);
    const bodyStr = JSON.stringify(body);
    const signature = sign(bodyStr);

    const options = {
      hostname: HOST,
      port: PORT,
      path: '/api/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'x-signature': signature,
      },
    };

    const startTime = Date.now();

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          index,
          status: res.statusCode,
          duration: Date.now() - startTime,
          eventId: body.eventId,
          ok: res.statusCode === 202,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        index,
        status: 0,
        duration: Date.now() - startTime,
        eventId: body.eventId,
        ok: false,
        error: err.message,
      });
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * Batched mode: fire BATCH_SIZE requests every BATCH_INTERVAL_MS ms.
 * Uses setInterval so batches start on a fixed cadence regardless of response time.
 * This simulates a sustained request rate rather than a single thundering herd.
 *
 * Each batch's Promise.all is collected into allBatchPromises and the function
 * awaits all of them before returning — no fire-and-forget, no silent result drops.
 */
async function runBatched() {
  const allBatchPromises = [];
  let dispatched = 0;

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      const start = dispatched;
      const end = Math.min(dispatched + BATCH_SIZE, TOTAL);
      const batch = [];

      for (let i = start; i < end; i++) {
        batch.push(sendRequest(i));
        dispatched++;
      }

      allBatchPromises.push(Promise.all(batch));

      if (dispatched >= TOTAL) {
        clearInterval(interval);
        resolve();
      }
    }, BATCH_INTERVAL_MS);
  });

  // Wait for every in-flight request across all batches to settle.
  const batchResults = await Promise.all(allBatchPromises);
  return batchResults.flat();
}

async function run() {
  const mode = BATCHED_MODE ? 'batched (10 req / 50ms)' : 'concurrent (all at once)';
  console.log(`\nFiring ${TOTAL} requests to http://${HOST}:${PORT}/api/events [mode: ${mode}]\n`);

  const start = Date.now();

  let results;
  if (BATCHED_MODE) {
    results = await runBatched();
  } else {
    // Concurrent mode: all 100 at the same instant.
    // Note: Node.js http.globalAgent has maxSockets: Infinity, so all requests go out
    // simultaneously. Latency numbers include TCP handshake and reflect the client-side
    // wall time. For production load testing, prefer k6 or autocannon which provide
    // per-percentile histograms and connection-limited scenarios.
    results = await Promise.all(
      Array.from({ length: TOTAL }, (_, i) => sendRequest(i))
    );
  }

  const totalTime = Date.now() - start;

  // Analysis
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const durations = results.map((r) => r.duration).sort((a, b) => a - b);
  const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const under150 = durations.filter((d) => d < 150).length;

  console.log('═══════════════════════════════════════════');
  console.log('           LOAD TEST RESULTS               ');
  console.log('═══════════════════════════════════════════');
  console.log(`  Total requests  : ${TOTAL}`);
  console.log(`  Passed (202)    : ${passed.length}`);
  console.log(`  Failed          : ${failed.length}`);
  console.log(`  Under 150ms     : ${under150}/${TOTAL}`);
  console.log(`  Min latency     : ${durations[0]}ms`);
  console.log(`  p50 latency     : ${p50}ms`);
  console.log(`  p95 latency     : ${p95}ms`);
  console.log(`  Avg latency     : ${avgDuration}ms`);
  console.log(`  Max latency     : ${durations[durations.length - 1]}ms`);
  console.log(`  Total wall time : ${totalTime}ms`);
  console.log('═══════════════════════════════════════════');

  if (failed.length > 0) {
    console.log('\nFAILED REQUESTS:');
    failed.forEach((r) => {
      console.log(`  [${r.index}] status=${r.status} eventId=${r.eventId} ${r.error ?? ''}`);
    });
  } else {
    console.log('\nALL 100 REQUESTS ACCEPTED — ZERO FAILURES');
  }

  console.log('\nFull results (index | status | duration | eventId):');
  results
    .sort((a, b) => a.index - b.index)
    .forEach((r) => {
      const mark = r.ok ? 'v' : 'x';
      console.log(`  ${mark} [${String(r.index).padStart(3)}] ${r.status} | ${String(r.duration).padStart(4)}ms | ${r.eventId}`);
    });

  // Return accepted eventIds for the optional end-to-end verification phase.
  return passed.map((r) => r.eventId);
}
// ---------------------------------------------------------------------------
// End-to-end verification: poll GET /api/events/:eventId until all events
// reach a terminal state (completed or dead_lettered). Proves the full
// pipeline works — not just ingestion acceptance.
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set(['completed', 'dead_lettered']);
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS  = 60_000;

function fetchEventStatus(eventId) {
  return new Promise((resolve) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: `/api/events/${eventId}`,
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({ eventId, status: body.status, httpStatus: res.statusCode });
        } catch {
          resolve({ eventId, status: 'unknown', httpStatus: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ eventId, status: 'error', error: err.message });
    });

    req.end();
  });
}

async function verifyEndToEnd(eventIds) {
  if (!API_KEY) {
    console.log('\nSkipping end-to-end verification: API_KEY is not set.');
    console.log('Set API_KEY alongside WEBHOOK_SECRET to enable --verify.\n');
    return;
  }

  console.log(`\n───────────────────────────────────────────`);
  console.log(`  END-TO-END VERIFICATION (polling ${eventIds.length} events)`);
  console.log(`───────────────────────────────────────────\n`);

  const pending = new Set(eventIds);
  const finalStates = new Map();
  const startTime = Date.now();

  while (pending.size > 0 && Date.now() - startTime < POLL_TIMEOUT_MS) {
    const batch = [...pending];
    const results = await Promise.all(batch.map(fetchEventStatus));

    for (const result of results) {
      if (TERMINAL_STATES.has(result.status)) {
        pending.delete(result.eventId);
        finalStates.set(result.eventId, result.status);
      }
    }

    if (pending.size > 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}s] ${finalStates.size}/${eventIds.length} terminal — ${pending.size} still processing...`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  // Timed-out events
  for (const id of pending) {
    finalStates.set(id, 'timeout');
  }

  // Summary
  const completed = [...finalStates.values()].filter((s) => s === 'completed').length;
  const deadLettered = [...finalStates.values()].filter((s) => s === 'dead_lettered').length;
  const timedOut = [...finalStates.values()].filter((s) => s === 'timeout').length;
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`       END-TO-END RESULTS (${elapsed}s)         `);
  console.log(`═══════════════════════════════════════════`);
  console.log(`  Completed       : ${completed}`);
  console.log(`  Dead-lettered   : ${deadLettered}`);
  console.log(`  Timed out       : ${timedOut}`);
  console.log(`  Total processed : ${completed + deadLettered}/${eventIds.length}`);
  console.log(`═══════════════════════════════════════════`);

  if (timedOut > 0) {
    console.log('\nTIMED-OUT EVENTS (still processing after 60s):');
    for (const [id, status] of finalStates) {
      if (status === 'timeout') console.log(`  ${id}`);
    }
  }

  if (completed + deadLettered === eventIds.length) {
    console.log('\nALL EVENTS REACHED TERMINAL STATE — PIPELINE VERIFIED ✔');
  }
}

// --- Main ---
run().then(async (eventIds) => {
  if (VERIFY_E2E && eventIds?.length) {
    await verifyEndToEnd(eventIds);
  }
});
