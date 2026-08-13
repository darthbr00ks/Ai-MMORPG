'use client';

import { useState } from 'react';

interface Props {
  characterId: string;
}

export default function DirectiveForm({ characterId }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const MAX = 500;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || text.length > MAX) return;

    setStatus('submitting');
    try {
      const res = await fetch('/api/directives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, text }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setMessage('Directive submitted. Your character will act on it next tick.');
        setText('');
      } else {
        setStatus('error');
        setMessage(data.error || 'Failed to submit directive');
      }
    } catch {
      setStatus('error');
      setMessage('Network error');
    }
  };

  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-amber-800">
      <h3 className="font-semibold mb-3 text-amber-300">📜 Give a Directive</h3>
      <p className="text-gray-400 text-sm mb-3">
        Write what you want this character to pursue. You get ≤500 characters, once per day. After that, you lose control until tomorrow.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value.slice(0, MAX));
              setStatus('idle');
            }}
            placeholder="e.g. Make friends with the mayor. Earn their trust, attend their events, offer help..."
            rows={4}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-amber-600"
          />
          <span
            className={`absolute bottom-2 right-2 text-xs ${
              text.length > 450 ? 'text-red-400' : 'text-gray-500'
            }`}
          >
            {text.length}/{MAX}
          </span>
        </div>
        {message && (
          <p className={`text-sm ${status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
            {message}
          </p>
        )}
        <button
          type="submit"
          disabled={status === 'submitting' || text.trim().length === 0 || text.length > MAX}
          className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2 px-4 rounded transition-colors"
        >
          {status === 'submitting' ? 'Submitting...' : 'Commit Directive'}
        </button>
      </form>
    </div>
  );
}
