'use client';

import { useEffect } from 'react';

export interface WorldStreamEvent {
  id: string;
  type: string;
  actorCharacterId: string | null;
  targetCharacterId: string | null;
  actorName?: string | null;
  targetName?: string | null;
  locationId: string | null;
  locationName?: string | null;
  description?: string;
  importance?: number;
  createdAt?: string;
  payload: Record<string, unknown>;
}

export function useWorldEvents(onEvent: (event: WorldStreamEvent) => void) {
  useEffect(() => {
    const evtSource = new EventSource('/api/events/stream');

    evtSource.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data) as WorldStreamEvent);
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      evtSource.close();
    };
  }, [onEvent]);
}
