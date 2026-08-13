export interface Location {
  id: string;
  slug: string;
  connections: string[]; // array of slugs
}

export interface MovementResult {
  valid: boolean;
  reason?: string;
  travelEtaMs?: number;
}

export function validateMovement(
  currentLocationSlug: string,
  destinationSlug: string,
  locations: Location[],
  travelTimeMs = 60_000 // default 1 minute
): MovementResult {
  const currentLoc = locations.find((l) => l.slug === currentLocationSlug);
  if (!currentLoc) {
    return { valid: false, reason: `Current location '${currentLocationSlug}' not found` };
  }
  const destLoc = locations.find((l) => l.slug === destinationSlug);
  if (!destLoc) {
    return { valid: false, reason: `Destination '${destinationSlug}' not found` };
  }
  if (!currentLoc.connections.includes(destinationSlug)) {
    return {
      valid: false,
      reason: `'${destinationSlug}' is not connected to '${currentLocationSlug}'. Connected: ${currentLoc.connections.join(', ')}`,
    };
  }
  return { valid: true, travelEtaMs: travelTimeMs };
}

export function isLocationConnected(
  fromSlug: string,
  toSlug: string,
  locations: Location[]
): boolean {
  const from = locations.find((l) => l.slug === fromSlug);
  return from ? from.connections.includes(toSlug) : false;
}
