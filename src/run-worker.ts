// Worker thread entry used by the command line only (src/deadline.ts starts it). It runs the same
// run() the library exports, so a hostile document that keeps the parser busy can be stopped by
// terminating this thread at the deadline. Nothing in the library core imports this file or
// node:worker_threads; test/core.test.ts walks the core's import graph to keep it that way.

import { parentPort, workerData } from 'node:worker_threads';
import { run, RunError, type RunOptions, type SourceInput } from './run.js';

export interface WorkerInput {
  html: SourceInput;
  markdown: SourceInput;
  options: RunOptions;
}

export type WorkerOutput =
  | { ok: true; report: ReturnType<typeof run> }
  | { ok: false; runError: boolean; message: string; value?: string; stack?: string };

/** The first message says the modules are loaded and the deadline may start; the second is the result. */
export type WorkerMessage = { ready: true } | (WorkerOutput & { ready?: undefined });

function reply(out: WorkerMessage): void {
  parentPort!.postMessage(out);
}

// Static imports are evaluated before this line, so the parsers are loaded when the main thread
// starts the deadline. run() begins right after, in the same turn.
reply({ ready: true });

try {
  const input = workerData as WorkerInput;
  reply({ ok: true, report: run(input.html, input.markdown, input.options) });
} catch (err) {
  if (err instanceof RunError) reply({ ok: false, runError: true, message: err.message, value: err.value });
  else reply({ ok: false, runError: false, message: (err as Error)?.message ?? String(err), stack: (err as Error)?.stack });
}
