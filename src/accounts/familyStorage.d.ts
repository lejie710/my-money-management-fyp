import {
  StorageAdapter,
  createLedgerStorage,
} from "../core/storage";
import { LedgerIdentityContext } from "../core/model";
import { DataFamily } from "./identity";
export type FamilyLedgerStorage = ReturnType<typeof createLedgerStorage>;
export function familyStorageKeys(family: DataFamily): {
  key: string;
  legacyKeys: string[];
};
export function createFamilyLedgerStorage(
  adapter: StorageAdapter,
  family: DataFamily,
  options?: { identityContext?: LedgerIdentityContext },
): FamilyLedgerStorage;
