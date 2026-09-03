export interface UntilClock {
  readonly clearTimeout: (handle: number) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => number;
}

let nextTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const systemClock: UntilClock = {
  clearTimeout(handle) {
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    systemTimers.delete(handle);
    clearTimeout(timer);
  },
  now: Date.now,
  setTimeout(callback, delay) {
    nextTimerId += 1;
    const id = nextTimerId;
    const timer = setTimeout(() => {
      systemTimers.delete(id);
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Clock scheduling is a callback API.
      callback();
    }, delay);
    timer.unref();
    systemTimers.set(id, timer);
    return id;
  },
};
