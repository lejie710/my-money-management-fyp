import { ReminderScope, ReminderActor } from '../reminders/coordinator';
export type DataScope = ReminderScope;
export type DataActor = ReminderActor;
export type DataFamily = { scope: DataScope; actor: DataActor };
export type AccountUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
};
export function encodeDataFamily(family: DataFamily): string;
export function validateDataFamily(family: unknown): DataFamily;
export function encodeDataScope(scope: DataScope): string;
export function sameDataFamily(left: DataFamily, right: DataFamily): boolean;
export function familyForUser(
  scope: DataScope,
  user: AccountUser | null,
  projectId?: string,
): DataFamily;
export function projectAccountUser(value: unknown): AccountUser | null;
export function normalizeDisplayName(value: unknown): string;
export function normalizeCredentials(value: unknown): {
  email: string;
  password: string;
};
export function safeAuthMessage(error: unknown, operation: string): string;
