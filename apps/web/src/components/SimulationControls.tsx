'use client';

import { useEffect, useState } from 'react';

interface SimulationControlState {
  paused: boolean;
  speedMultiplier: number;
  pendingManualTicks: number;
}

type Action = 'pause' | 'resume' | 'run_tick' | 'run_day' | 'set_speed';

const SPEED_OPTIONS = [0.5, 1, 2, 5] as const;
const POLL_INTERVAL_MS = 3000;

/**
 * Simulation Test Mode controls (§13): Pause/Resume/Run 1 Tick/
 * Run 1 Day/speed multipliers. Polls GET /api/admin/simulation-control
 * on a short interval so the pendingManualTicks counter (draining as
 * the worker claims them) and paused state stay live without a
 * manual refresh.
 */
export default function SimulationControls({
  initialControl,
}: {
  initialControl: SimulationControlState;
}) {
  const [control, setControl] = useState(initialControl);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/simulation-control');
        if (!res.ok) return;
        const data = await res.json();
        setControl(data.control);
      } catch {
        // Transient poll failure — try again next tick, don't surface it.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  async function sendAction(action: Action, extra?: Record<string, unknown>) {
    setPending(action);
    setError(null);
    try {
      const res = await fetch('/api/admin/simulation-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const data = await res.json();
      setControl(data.control);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Simulation Test Mode</h3>
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            control.paused ? 'bg-amber-900 text-amber-300' : 'bg-green-900 text-green-300'
          }`}
        >
          {control.paused ? '⏸ Paused' : '▶ Running'}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          onClick={() => sendAction(control.paused ? 'resume' : 'pause')}
          disabled={pending !== null}
          className="text-sm px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
        >
          {control.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => sendAction('run_tick')}
          disabled={pending !== null}
          className="text-sm px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
        >
          Run 1 Tick
        </button>
        <button
          onClick={() => sendAction('run_day')}
          disabled={pending !== null}
          className="text-sm px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
        >
          Run 1 Day
        </button>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400">Speed:</span>
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => sendAction('set_speed', { speedMultiplier: s })}
            disabled={pending !== null}
            className={`px-2 py-1 rounded ${
              control.speedMultiplier === s
                ? 'bg-amber-700 text-white'
                : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
            } disabled:opacity-50`}
          >
            {s}x
          </button>
        ))}
      </div>

      {control.pendingManualTicks > 0 && (
        <p className="text-xs text-gray-500 mt-3">
          {control.pendingManualTicks} manually-queued tick{control.pendingManualTicks === 1 ? '' : 's'} remaining
        </p>
      )}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
