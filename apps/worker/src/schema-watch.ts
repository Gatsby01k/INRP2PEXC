/**
 * A production worker runs only against the schema it was built for. `main.ts` checks that once, at start
 * (`databaseDeploymentProblems`); this keeps checking while it runs.
 *
 * A release migrates the database first and replaces the worker image after. A worker left running across the migration
 * kept running every job of the old release against the new schema: each per-minute job failed once a minute (each
 * failure a permanently failed queue row naming a table or column the migration had removed — the kind production's
 * queue holds), and a job that did not fail ran old code against new rules. Now, within a minute of the schema moving, the
 * worker stops taking jobs, lets the running ones finish, and exits non-zero; started again with the same image it
 * refuses to start, out loud, until the image of the new release is deployed — the state the release order
 * (DEPLOYMENT: "stop the worker", migrate, new image) already asks for.
 *
 * Only a definite answer stops it: a check that cannot reach the database (a network blip, a compute restart) changes
 * nothing, and the next check decides.
 */
export interface SchemaWatch {
  /** Stops watching (the runner is not touched). */
  close(): void;
  /** Resolves once a definite problem stopped the worker, with the reasons. */
  readonly stopped: Promise<readonly string[]>;
}

export function watchSchema(opts: {
  readonly check: () => Promise<readonly string[]>;
  readonly stop: (problems: readonly string[]) => Promise<void>;
  readonly intervalMs?: number;
  readonly onCheckFailed?: (error: unknown) => void;
}): SchemaWatch {
  let resolve!: (p: readonly string[]) => void;
  const stopped = new Promise<readonly string[]>((r) => {
    resolve = r;
  });
  let busy = false;
  let done = false;
  const timer = setInterval(() => {
    if (busy || done) return;
    busy = true;
    void opts.check().then(
      async (problems) => {
        if (problems.length === 0 || done) return;
        done = true;
        clearInterval(timer);
        await opts.stop(problems);
        resolve(problems);
      },
      (e: unknown) => opts.onCheckFailed?.(e),
    ).finally(() => {
      busy = false;
    });
  }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return {
    close: () => {
      done = true;
      clearInterval(timer);
    },
    stopped,
  };
}
