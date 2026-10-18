/**
 * Native SDK58 request normalization. Android uses native date/value; iOS accepts
 * only an owned, nonrepeating timeInterval with saved requestedScheduledAtMs.
 * Returns null for unsupported, foreign, malformed, or repeating requests.
 * iOS behavior is source-inspected; native iOS execution remains unverified.
 */
export function scheduledNotificationInstant(platform: string, request: unknown): number | null;
