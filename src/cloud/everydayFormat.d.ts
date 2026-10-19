import type { Ledger } from '../core/model';
import type { DataFamily } from '../accounts/identity';
import type { PhotoRef } from '../core/transactionContext';
export type CloudOwner = { projectId: string; uid: string };
export type WalletPhoto = { photo: PhotoRef; sha256: string };
export type CloudWalletRecord = {
  version: 1;
  ownerUid: string;
  revision: number;
  operationId: string;
  updatedAtMs: number;
  payload: string;
  payloadHash: string;
};
export const MAX_WALLET_BYTES: number;
export const MAX_WALLET_PHOTOS: number;
export function everydayKeys(family: DataFamily): {
  familyToken: string;
  cache: string;
  draft: string;
  walletId: string;
};
export function checkedLedger(value: unknown): Ledger;
export function ledgerPhotos(ledger: Ledger): PhotoRef[];
export function operationId(value: string): string;
export function decodeRecord(
  value: unknown,
  owner: CloudOwner,
): { record: CloudWalletRecord; ledger: Ledger; photos: WalletPhoto[] };
export function makeRecord(options: {
  ledger: Ledger;
  photos: WalletPhoto[];
  owner: CloudOwner;
  revision: number;
  id: string;
  nowMs: number;
}): CloudWalletRecord;
export function validateOperation(
  value: unknown,
  owner: CloudOwner,
  id: string,
): { version: 1; ownerUid: string; operationId: string; revision: number; payloadHash: string };
