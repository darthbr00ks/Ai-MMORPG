'use client';

import { useState } from 'react';
import DiplomacyView from '@/components/DiplomacyView';
import World3DScene from '@/components/World3DScene';
import { useWorldSnapshot } from '@/lib/use-world-snapshot';

export default function WorldMap() {
  const [viewMode, setViewMode] = useState<'world' | 'diplomacy'>('world');
  const { snapshot, snapshotError } = useWorldSnapshot();

  if (snapshotError && !snapshot) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center text-gray-500 text-sm">
        Couldn&apos;t load the world view — the simulation worker or database may be unavailable.
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-8 text-center text-gray-500 text-sm">
        Loading New Concord…
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div>
          <div className="text-sm font-medium">New Concord</div>
          <div className="text-xs text-gray-500">
            World view is now the primary interface. Diplomacy remains secondary.
          </div>
        </div>
        <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
          <button
            onClick={() => setViewMode('world')}
            className={`px-3 py-1 transition-colors ${
              viewMode === 'world'
                ? 'bg-amber-900 text-amber-200'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            🌍 World
          </button>
          <button
            onClick={() => setViewMode('diplomacy')}
            className={`px-3 py-1 transition-colors ${
              viewMode === 'diplomacy'
                ? 'bg-amber-900 text-amber-200'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            ⚑ Diplomacy
          </button>
        </div>
      </div>

      {viewMode === 'world' ? <World3DScene snapshot={snapshot} /> : <DiplomacyView />}
    </div>
  );
}
