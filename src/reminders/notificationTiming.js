const { parseNotificationOwner } = require('./store');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const absoluteTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;

/** Normalize only supported native shapes belonging to this app's manual reminders. */
function scheduledNotificationInstant(platform, request) {
  if (!object(request) || !object(request.trigger) || !object(request.content)) return null;
  const owner = parseNotificationOwner({
    identifier: request.identifier,
    data: request.content.data,
  });
  if (!owner || owner.data.kind !== 'manual') return null;
  const trigger = request.trigger;
  if (trigger.repeats !== false) return null;

  // SDK 58 Android DateTrigger.toBundle exposes the native absolute timestamp.
  // Metadata must never override this value, even if the requested time differs.
  if (platform === 'android' && trigger.type === 'date') {
    return absoluteTime(trigger.value) ? trigger.value : null;
  }

  // Source-inspected, not runtime-verified on iOS: SDK 58 TriggerRecords.swift
  // converts date input to nonrepeating UNTimeIntervalNotificationTrigger.
  // NotificationRecords.swift returns its original interval, not an absolute time
  // or a countdown. Only our validated metadata can recover the requested instant.
  if (
    platform === 'ios' &&
    trigger.type === 'timeInterval' &&
    typeof trigger.seconds === 'number' &&
    Number.isFinite(trigger.seconds) &&
    trigger.seconds > 0 &&
    absoluteTime(owner.data.requestedScheduledAtMs)
  ) {
    return owner.data.requestedScheduledAtMs;
  }
  return null;
}

module.exports = { scheduledNotificationInstant };
