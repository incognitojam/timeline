/** Parse fractional hours from an ISO timestamp's time portion. */
export function timeToHours(isoTimestamp: string): number {
  const hours = parseInt(isoTimestamp.slice(11, 13), 10);
  const minutes = parseInt(isoTimestamp.slice(14, 16), 10);
  return hours + minutes / 60;
}

/**
 * Calculate average sleep time from an array of ISO timestamps using circular mean.
 * Treats hours as angles on a 24-hour clock (via sin/cos/atan2) so midnight
 * crossover is handled correctly without any special-casing.
 */
export function averageSleepTime(timestamps: string[]): number | null {
  if (timestamps.length === 0) return null;
  const hours = timestamps.map(t => timeToHours(t));
  const TAU = 2 * Math.PI;
  let sinSum = 0, cosSum = 0;
  for (const h of hours) {
    const angle = (h / 24) * TAU;
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
  }
  const avgAngle = Math.atan2(sinSum / hours.length, cosSum / hours.length);
  const avgHours = (avgAngle / TAU) * 24;
  return ((avgHours % 24) + 24) % 24;
}
