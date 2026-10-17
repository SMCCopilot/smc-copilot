/** Per-session sequence tracking: drops duplicates and anything older than what was already applied. */
export function createSeqFilter(start = 0) {
  let last = start;
  return {
    /** True when the event is new and should be applied. */
    accept: (seq: number): boolean => {
      if (!Number.isInteger(seq) || seq <= last) return false;
      last = seq;
      return true;
    },
    last: () => last,
  };
}

/** Collects work and runs it once per animation frame so a burst of events causes one redraw. */
export function createFrameBatcher(
  schedule: (cb: () => void) => void,
  flush: (items: string[]) => void,
) {
  const pending = new Set<string>();
  let queued = false;
  return (key: string) => {
    pending.add(key);
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const items = [...pending];
      pending.clear();
      flush(items);
    });
  };
}

/** Plain-language state for the feed chip. */
export type LiveState = 'IDLE' | 'CONNECTING' | 'LIVE' | 'RESYNCING' | 'STALE' | 'TAKEN' | 'ENDED';
