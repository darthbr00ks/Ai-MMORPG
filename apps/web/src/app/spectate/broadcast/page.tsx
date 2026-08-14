'use client';

import { useEffect, useRef, useState } from 'react';
import { CharacterAvatar } from '@/components/CharacterAvatar';

interface BroadcastEvent {
  id: string;
  type: string;
  actorCharacterId: string | null;
  actorName: string | null;
  targetName: string | null;
  locationName: string | null;
  description: string;
  importance: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

// Below this importance, an event is routine simulation noise (a lone
// CHARACTER_IDLE, a rejected action) — fine for the full /spectate
// feed, not worth a full-screen broadcast scene.
const MIN_BROADCAST_IMPORTANCE = 0.15;
const MAX_SCENES_IN_ROTATION = 12;
const SCENE_DURATION_MS = 6000;
const FADE_MS = 500;

/**
 * OBS-ready rotating-scene spectator view (§16). One event fills the
 * whole viewport at a time — big text, minimal chrome, dark
 * background — meant to be captured as a browser source, not browsed
 * interactively. A fresh, sufficiently important event jumps the
 * rotation back to itself immediately (a "breaking news" cut) rather
 * than waiting its turn in the queue.
 */
export default function SpectateBroadcastPage() {
  const [scenes, setScenes] = useState<BroadcastEvent[]>([]);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const evtSource = new EventSource('/api/events/stream');

    evtSource.onmessage = (e) => {
      let event: BroadcastEvent;
      try {
        event = JSON.parse(e.data) as BroadcastEvent;
      } catch {
        return;
      }
      if (event.importance < MIN_BROADCAST_IMPORTANCE) return;

      setScenes((prev) => {
        if (prev.some((s) => s.id === event.id)) return prev;
        return [event, ...prev].slice(0, MAX_SCENES_IN_ROTATION);
      });
      // A fresh scene cuts to itself immediately rather than joining
      // the back of the rotation.
      setSceneIndex(0);
    };

    return () => evtSource.close();
  }, []);

  // Advance through the rotation on a fixed cadence, with a brief
  // fade-out/fade-in rather than an abrupt swap.
  useEffect(() => {
    if (scenes.length < 2) return;

    const interval = setInterval(() => {
      setVisible(false);
      fadeTimeoutRef.current = setTimeout(() => {
        setSceneIndex((i) => (i + 1) % scenes.length);
        setVisible(true);
      }, FADE_MS);
    }, SCENE_DURATION_MS);

    return () => {
      clearInterval(interval);
      if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
    };
  }, [scenes.length]);

  const scene = scenes[sceneIndex] ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-gradient-to-b from-gray-950 to-gray-900 flex items-center justify-center overflow-hidden">
      <a
        href="/spectate"
        className="absolute top-4 right-4 text-xs text-gray-600 hover:text-gray-400"
      >
        exit broadcast view
      </a>

      {!scene ? (
        <p className="text-gray-500 text-xl">Waiting for New Concord to do something interesting…</p>
      ) : (
        <div
          className="flex flex-col items-center gap-6 px-12 text-center transition-opacity ease-out"
          style={{ opacity: visible ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        >
          {scene.locationName && (
            <span className="uppercase tracking-[0.3em] text-amber-400 text-sm font-semibold">
              {scene.locationName}
            </span>
          )}

          <CharacterAvatar
            seed={scene.actorCharacterId ?? scene.id}
            size={160}
            className="rounded-full bg-gray-800 shadow-2xl"
          />

          {scene.actorName && (
            <h1 className="text-5xl font-bold text-white">
              {scene.actorName}
              {scene.targetName && (
                <span className="text-gray-400 font-normal"> &amp; {scene.targetName}</span>
              )}
            </h1>
          )}

          <p className="text-2xl text-gray-200 max-w-3xl">{scene.description}</p>

          <span className="text-gray-600 text-sm">
            {new Date(scene.createdAt).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
