import { config } from '../config.js';
import { claimJobs, completeJob, failJob, runPushAri } from '../services/sync.js';

/**
 * Pulls jobs off sync_jobs and runs them.
 *
 * Runs as its own process in production so a slow channel can never make the
 * UI unresponsive - that is the whole reason the sync is a queue rather than
 * being done inline when someone edits a rate.
 */
export function startWorker(workerId = `w-${process.pid}`) {
  let stopped = false;
  let consecutiveErrors = 0;

  const log = (level, message, detail) => {
    const line = `[worker ${workerId}] ${message}`;
    if (level === 'error') console.error(line, detail || '');
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  async function tick() {
    if (stopped) return;
    try {
      const jobs = await claimJobs(workerId, config.worker.batchSize);
      consecutiveErrors = 0;

      for (const job of jobs) {
        try {
          if (job.job_type === 'push_ari') {
            await runPushAri(job, log);
          } else {
            throw new Error(`Unknown job type "${job.job_type}"`);
          }
          await completeJob(job.id);
        } catch (err) {
          const outcome = await failJob(job, err);
          if (outcome.retried) {
            log('warn', `job ${job.id} failed (attempt ${job.attempts}/${job.max_attempts}), retrying in ${outcome.delaySec}s: ${err.message}`);
          } else {
            log('error', `job ${job.id} gave up after ${job.attempts} attempts: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // A database blip must not kill the worker. Back off so a hard outage
      // does not turn into a tight error loop.
      consecutiveErrors++;
      log('error', `queue poll failed (${consecutiveErrors} in a row)`, err.message);
      if (consecutiveErrors > 3) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    } finally {
      if (!stopped) setTimeout(tick, config.worker.pollMs);
    }
  }

  log('info', 'started');
  tick();

  return { stop: () => { stopped = true; } };
}
