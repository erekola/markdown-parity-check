// Time limit for the parse-and-compare step of the command line. The Markdown and HTML parsers are
// synchronous, so a timer on the same thread cannot interrupt them. The step therefore runs in a
// worker thread (src/run-worker.ts) that is terminated at the deadline. The library core does not
// use this file (see src/core.ts).
//
// The deadline starts when the worker reports that its modules are loaded, not when it is spawned:
// starting a thread and loading the parsers takes about 170 ms, and counting that would make a small
// --timeout-ms value fail an ordinary local run (QA 1, Q6). A separate, generous start limit covers a
// worker that never becomes ready.

import { Worker } from 'node:worker_threads';
import { RunError, type Report, type RunOptions, type SourceInput } from './run.js';
import type { WorkerInput, WorkerMessage } from './run-worker.js';

/** How long the worker may take to load before the run is given up. Not tied to --timeout-ms. */
const START_LIMIT_MS = 30_000;

/** Runs run(html, markdown, options) in a worker thread and fails with a RunError (exit 2) when it has not finished after timeoutMs. */
export function runWithDeadline(html: SourceInput, markdown: SourceInput, options: RunOptions, timeoutMs: number): Promise<Report> {
  return new Promise<Report>((resolve, reject) => {
    const input: WorkerInput = { html, markdown, options };
    const worker = new Worker(new URL('./run-worker.js', import.meta.url), { workerData: input });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const startTimer = setTimeout(() => {
      finish(() => reject(new RunError(`The comparison worker did not start within ${START_LIMIT_MS} ms.`)));
    }, START_LIMIT_MS);
    worker.on('message', (msg: WorkerMessage) => {
      if (msg.ready) {
        clearTimeout(startTimer);
        if (!settled) {
          timer = setTimeout(() => {
            finish(() => reject(new RunError(`Timed out after ${timeoutMs} ms while parsing and comparing the two documents (--timeout-ms covers this step as well as each fetch).`)));
          }, timeoutMs);
        }
        return;
      }
      const out = msg;
      finish(() => {
        if (out.ok) resolve(out.report);
        else if (out.runError) reject(new RunError(out.message, out.value));
        else {
          const e = new Error(out.message);
          if (out.stack !== undefined) e.stack = out.stack;
          reject(e);
        }
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`The comparison worker stopped without a result (exit ${code}).`))));
  });
}
