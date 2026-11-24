/**
 * 单飞合并执行器：同一时刻最多允许 1 个异步请求在飞；
 * 在飞期间新触发的请求不会丢失，而是合并为一次后续执行（forceReset 取逻辑或）。
 */

export interface PollRequest {
  forceReset: boolean;
}

export function createCoalescingRunner(
  execute: (req: PollRequest) => Promise<void>,
): { trigger(req: PollRequest): Promise<void> } {
  let running = false;
  let pending: PollRequest | null = null;
  let drainPromise: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    running = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        await execute(next);
      }
    } finally {
      running = false;
      drainPromise = null;
    }
  };

  return {
    trigger(req: PollRequest): Promise<void> {
      pending = pending
        ? { forceReset: pending.forceReset || req.forceReset }
        : { forceReset: req.forceReset };
      if (!running) {
        drainPromise = drain();
      }
      return drainPromise ?? Promise.resolve();
    },
  };
}
