'use client';

import { useEffect, useState } from 'react';

interface GameEvent {
  id: string;
  type: string;
  actorName?: string;
  importance: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export default function EventFeed() {
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const evtSource = new EventSource('/api/events/stream');

    evtSource.onopen = () => setConnected(true);

    evtSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as GameEvent;
        setEvents((prev) => [event, ...prev].slice(0, 50));
      } catch {
        // ignore parse errors
      }
    };

    evtSource.addEventListener('heartbeat', () => {
      // Keep alive
    });

    evtSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      evtSource.close();
    };
  }, []);

  const importanceColor = (imp: number) => {
    if (imp >= 0.7) return 'text-red-400';
    if (imp >= 0.4) return 'text-amber-400';
    return 'text-gray-400';
  };

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <span className="text-sm font-medium">Events</span>
        <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
          {connected ? '● Live' : '○ Disconnected'}
        </span>
      </div>
      <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            Waiting for simulation events...
          </div>
        ) : (
          events.map((event) => (
            <div key={event.id} className="px-4 py-2 flex items-start gap-3">
              <span className={`text-xs font-mono mt-1 ${importanceColor(event.importance)}`}>
                {event.type}
              </span>
              <div className="flex-1 min-w-0">
                {event.actorName && (
                  <span className="text-amber-300 text-sm font-medium">{event.actorName}</span>
                )}
                <p className="text-gray-300 text-sm truncate">
                  {JSON.stringify(event.payload).slice(0, 80)}
                </p>
              </div>
              <span className="text-gray-600 text-xs whitespace-nowrap">
                {new Date(event.createdAt).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
