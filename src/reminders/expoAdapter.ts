import { Platform } from 'react-native';
import { isRunningInExpoGo, requireOptionalNativeModule } from 'expo';
import * as Notifications from './localNotifications';
import { scheduledNotificationInstant } from './notificationTiming';
import type {
  NotificationAdapter,
  ReminderNotificationData,
  ReminderPermission,
} from './coordinator';

const CHANNEL_ID = 'mmm-local-reminders';
let activeOwnerToken: string | null = null;
let handlerInstalled = false;

export function localReminderUnavailableReason(): string | null {
  // The standalone app can use native providers that are not exposed as optional
  // JS modules. Restrict this known-capability check to the observed Expo Go case.
  if (Platform.OS !== 'android' || !isRunningInExpoGo()) return null;
  if (requireOptionalNativeModule('NotificationsChannelsProvider')) return null;
  return 'This preview cannot schedule reminders. Open the project’s installed Android app to use them.';
}

function ownedData(value: unknown, ownerToken: string | null): ReminderNotificationData | null {
  if (!value || typeof value !== 'object' || !ownerToken) return null;
  const data = value as Record<string, unknown>;
  if (
    data.origin !== 'mmm-reminders-v1' ||
    data.ownerToken !== ownerToken ||
    typeof data.reminderId !== 'string' ||
    !data.reminderId ||
    !['manual', 'budget', 'goal', 'achievement'].includes(String(data.kind))
  )
    return null;
  return data as ReminderNotificationData;
}

export function setActiveReminderOwner(ownerToken: string | null) {
  activeOwnerToken = ownerToken;
}

export function installReminderPresentationHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = ownedData(notification.request.content.data, activeOwnerToken) !== null;
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
  });
}

async function permissionView(
  permission: Notifications.NotificationPermissionsStatus,
): Promise<ReminderPermission> {
  const iosStatus = permission.ios?.status;
  const allowed =
    Platform.OS === 'ios'
      ? iosStatus === Notifications.IosAuthorizationStatus.AUTHORIZED ||
        iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL ||
        iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL
      : permission.granted;
  const channel =
    Platform.OS === 'android' ? await Notifications.getNotificationChannelAsync(CHANNEL_ID) : null;
  return {
    status: allowed ? 'granted' : permission.status === 'undetermined' ? 'unknown' : 'denied',
    canAskAgain: permission.canAskAgain,
    channelEnabled: channel ? channel.importance !== Notifications.AndroidImportance.NONE : null,
  };
}

export const expoNotificationAdapter: NotificationAdapter = {
  async ensureChannel() {
    const unavailable = localReminderUnavailableReason();
    if (unavailable) throw new Error(unavailable);
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Wallet reminders',
        description: 'One-off reminders and optional recorded milestones.',
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
  },
  async getPermission() {
    if (localReminderUnavailableReason() || (Platform.OS !== 'android' && Platform.OS !== 'ios'))
      return { status: 'unavailable', canAskAgain: false, channelEnabled: null };
    return permissionView(await Notifications.getPermissionsAsync());
  },
  async requestPermission() {
    await expoNotificationAdapter.ensureChannel();
    if (Platform.OS !== 'android' && Platform.OS !== 'ios')
      return { status: 'unavailable', canAskAgain: false, channelEnabled: null };
    return permissionView(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    );
  },
  async listScheduled() {
    return (await Notifications.getAllScheduledNotificationsAsync()).map((request) => ({
      identifier: request.identifier,
      title: request.content.title ?? null,
      body: request.content.body ?? null,
      scheduledAtMs: scheduledNotificationInstant(Platform.OS, request),
      data: request.content.data,
    }));
  },
  async schedule(request) {
    await expoNotificationAdapter.ensureChannel();
    if (request.scheduledAtMs !== null && request.scheduledAtMs <= Date.now())
      throw new Error('That reminder time has passed. Choose a new future time.');
    return Notifications.scheduleNotificationAsync({
      identifier: request.identifier,
      content: {
        title: request.title,
        body: request.body,
        // iOS serializes a date request as an interval and loses its absolute time.
        // Preserve the requested instant for owned-request reconciliation, not as
        // evidence of the platform's exact firing time or actual presentation.
        data: { ...request.data, requestedScheduledAtMs: request.scheduledAtMs },
        sound: 'default',
      },
      trigger:
        request.scheduledAtMs === null
          ? Platform.OS === 'android'
            ? { channelId: CHANNEL_ID }
            : null
          : {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: request.scheduledAtMs,
              channelId: CHANNEL_ID,
              delivery: 'bestEffort',
            },
    });
  },
  async cancel(identifier) {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  },
};

export function subscribeToReminderNotifications(options: {
  ownerToken: string;
  onReceived: (data: ReminderNotificationData) => void;
  onOpen: (data: ReminderNotificationData) => void;
}) {
  let disposed = false;
  const open = (response: Notifications.NotificationResponse) => {
    const data = ownedData(response.notification.request.content.data, options.ownerToken);
    if (!disposed && data && activeOwnerToken === options.ownerToken) {
      options.onOpen(data);
      Notifications.clearLastNotificationResponse();
    }
  };
  const received = Notifications.addNotificationReceivedListener((notification) => {
    const data = ownedData(notification.request.content.data, options.ownerToken);
    if (!disposed && data && activeOwnerToken === options.ownerToken) options.onReceived(data);
  });
  const opened = Notifications.addNotificationResponseReceivedListener(open);
  const last = Notifications.getLastNotificationResponse();
  if (last) open(last);
  return () => {
    disposed = true;
    received.remove();
    opened.remove();
  };
}
