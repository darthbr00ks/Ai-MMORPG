'use client';

import { useEffect, useState } from 'react';
import type { WorldSnapshot } from '@/app/api/world/snapshot/route';

export const SNAPSHOT_POLL_MS = 5000;

export function useWorldSnapshot() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function pollOnce() {
      try {
        const res = await fetch('/api/world/snapshot');
        if (!res.ok) {
          throw new Error(`snapshot fetch failed: ${res.status}`);
        }
        const data = (await res.json()) as WorldSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setSnapshotError(false);
        }
      } catch {
        if (!cancelled) {
          setSnapshotError(true);
        }
      }
    }

    pollOnce();
    const interval = setInterval(pollOnce, SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { snapshot, snapshotError };
}
