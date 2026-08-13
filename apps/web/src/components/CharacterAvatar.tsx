/**
 * Deterministic, seeded, cute SVG portrait — no external image
 * generation, no network call, zero cost per §38 of the build plan
 * ("don't make image generation a dependency of routine simulation").
 * Same character id always renders the same friendly face, so avatars
 * stay stable across renders without persisting anything.
 */

// A small curated palette of warm, friendly body colors that read well
// against the app's dark gray-900 background — not a raw hash-to-hue,
// which tends to land on muddy or harsh colors.
const PALETTE = [
  { body: '#F5A667', cheek: '#E8895A' }, // coral
  { body: '#6FBF9E', cheek: '#4FA184' }, // sage
  { body: '#7FB2E5', cheek: '#5C93CC' }, // sky
  { body: '#E4A6D6', cheek: '#CB84BE' }, // orchid
  { body: '#F2C14E', cheek: '#DDA22E' }, // gold
  { body: '#9E9BE0', cheek: '#7F7BC9' }, // lavender
  { body: '#F08B7E', cheek: '#D96C5F' }, // rose
  { body: '#7ECBC4', cheek: '#57ACA4' }, // teal
] as const;

const FACES = ['happy', 'sleepy', 'grin', 'wink'] as const;
type Face = (typeof FACES)[number];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function faceFeatures(face: Face) {
  switch (face) {
    case 'sleepy':
      return {
        leftEye: <path d="M32 46 q6 -5 12 0" stroke="#2A2A2A" strokeWidth="3" fill="none" strokeLinecap="round" />,
        rightEye: <path d="M56 46 q6 -5 12 0" stroke="#2A2A2A" strokeWidth="3" fill="none" strokeLinecap="round" />,
        mouth: <ellipse cx="50" cy="60" rx="4" ry="3" fill="#2A2A2A" />,
      };
    case 'grin':
      return {
        leftEye: <circle cx="38" cy="46" r="4.5" fill="#2A2A2A" />,
        rightEye: <circle cx="62" cy="46" r="4.5" fill="#2A2A2A" />,
        mouth: <path d="M38 58 q12 12 24 0" stroke="#2A2A2A" strokeWidth="3.5" fill="none" strokeLinecap="round" />,
      };
    case 'wink':
      return {
        leftEye: <path d="M33 46 q5 -4 10 0" stroke="#2A2A2A" strokeWidth="3" fill="none" strokeLinecap="round" />,
        rightEye: <circle cx="62" cy="46" r="4.5" fill="#2A2A2A" />,
        mouth: <path d="M40 58 q10 8 20 0" stroke="#2A2A2A" strokeWidth="3" fill="none" strokeLinecap="round" />,
      };
    case 'happy':
    default:
      return {
        leftEye: <circle cx="38" cy="46" r="4.5" fill="#2A2A2A" />,
        rightEye: <circle cx="62" cy="46" r="4.5" fill="#2A2A2A" />,
        mouth: <path d="M40 58 q10 8 20 0" stroke="#2A2A2A" strokeWidth="3" fill="none" strokeLinecap="round" />,
      };
  }
}

export function CharacterAvatar({
  seed,
  size = 64,
  className,
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const hash = hashString(seed);
  const colors = PALETTE[hash % PALETTE.length];
  const face = FACES[Math.floor(hash / PALETTE.length) % FACES.length];
  const earTilt = (hash % 7) - 3; // small per-character variation, -3..3 degrees
  const { leftEye, rightEye, mouth } = faceFeatures(face);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label="Character portrait"
    >
      {/* ears */}
      <g transform={`rotate(${earTilt} 50 50)`}>
        <circle cx="26" cy="24" r="10" fill={colors.body} />
        <circle cx="74" cy="24" r="10" fill={colors.body} />
      </g>
      {/* head */}
      <circle cx="50" cy="52" r="34" fill={colors.body} />
      {/* blush cheeks */}
      <ellipse cx="30" cy="58" rx="6" ry="4" fill={colors.cheek} opacity="0.6" />
      <ellipse cx="70" cy="58" rx="6" ry="4" fill={colors.cheek} opacity="0.6" />
      {/* face */}
      {leftEye}
      {rightEye}
      {mouth}
    </svg>
  );
}
