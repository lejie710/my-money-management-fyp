// Compatibility boundary for expo-notifications 58.1.5 with Expo Go 58.0.4.
// The package root eagerly imports remote-topic/token modules absent from that
// Expo Go binary. Import only the shipped public local APIs and their types.
// Keep extensionless paths so Metro selects Android/native implementations.
// Recheck this boundary when either package or native runtime changes.
export {
  getPermissionsAsync,
  requestPermissionsAsync,
} from 'expo-notifications/build/NotificationPermissions';
export { setNotificationHandler } from 'expo-notifications/build/NotificationsHandler';
export {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponse,
  clearLastNotificationResponse,
} from 'expo-notifications/build/NotificationsEmitter';
export { scheduleNotificationAsync } from 'expo-notifications/build/scheduleNotificationAsync';
export { getAllScheduledNotificationsAsync } from 'expo-notifications/build/getAllScheduledNotificationsAsync';
export { cancelScheduledNotificationAsync } from 'expo-notifications/build/cancelScheduledNotificationAsync';
export { getNotificationChannelAsync } from 'expo-notifications/build/getNotificationChannelAsync';
export { setNotificationChannelAsync } from 'expo-notifications/build/setNotificationChannelAsync';
export {
  AndroidImportance,
  AndroidNotificationVisibility,
} from 'expo-notifications/build/NotificationChannelManager.types';
export { IosAuthorizationStatus } from 'expo-notifications/build/NotificationPermissions.types';
export { SchedulableTriggerInputTypes } from 'expo-notifications/build/Notifications.types';
export type { NotificationPermissionsStatus } from 'expo-notifications/build/NotificationPermissions.types';
export type { NotificationResponse } from 'expo-notifications/build/Notifications.types';
