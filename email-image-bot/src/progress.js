// Live progress of one job (used by the website's timeline). Code anywhere in the pipeline calls
// report('step') without having to pass a callback through every function; outside a job it does nothing.

import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage();

/** Runs fn with `onStep(step, detail)` receiving every report() made inside it. */
export function withProgress(onStep, fn) {
  return current.run(onStep, fn);
}

/**
 * Steps: 'fetch' (opening the page), 'browser' (rendering it in a browser), 'download' (downloading a
 * file), 'video' (saving / compressing a video), 'moderation' (modesty check).
 */
export function report(step, detail = '') {
  try {
    current.getStore()?.(step, detail);
  } catch {
    /* progress is cosmetic: never let it break the job */
  }
}
