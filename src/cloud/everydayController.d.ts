import type { Ledger, Currency } from '../core/model';
import type { DataFamily } from '../accounts/identity';
import type { EverydayCloudStore, CloudStoreState } from './everydayStore';
export type CloudWalletPreview = {
  token: string;
  source: 'local-account' | 'guest';
  walletName: string;
  currency: Currency;
  transactions: number;
  budgets: number;
  photos: number;
  balanceMinor: number;
  hasGoal: boolean;
};
export type CloudWalletState = {
  configured: boolean;
  signedIn: boolean;
  ownerToken: string | null;
  readOnly: boolean;
  busy: boolean;
  status: string;
  message: string;
  error: string;
  revision: number | null;
  cleanupPending: boolean;
  cleanupMessage: string;
  photosPending: number;
  draft: CloudStoreState['draft'];
  preview: CloudWalletPreview | null;
  canRefresh: boolean;
  canCopy: boolean;
  canRetryDraft: boolean;
  canDiscardDraft: boolean;
};
export type CloudWalletController = {
  getSnapshot(): CloudWalletState;
  subscribe(listener: () => void): () => void;
  ownerChanged(): void;
  dispose(): void;
  refresh(): Promise<boolean>;
  retryCleanup(): Promise<boolean>;
  previewCopy(source: 'local-account' | 'guest'): Promise<boolean>;
  confirmCopy(token: string): Promise<boolean>;
  cancelPreview(): void;
  retryDraft(token: string): Promise<boolean>;
  discardDraft(token: string): Promise<boolean>;
};
export function createEverydayCloudController(options: {
  getSetup(): {
    configured: boolean;
    signedIn: boolean;
    family: DataFamily | null;
    ownerToken: string | null;
    sessionToken: string;
  };
  storeFor(family: DataFamily): EverydayCloudStore;
  getBinding(): {
    family: DataFamily;
    ledger: Ledger;
    ownerToken: string;
    bindingToken: object;
    identityPending: boolean;
    allowed: boolean;
    compareAndSave(
      owner: string,
      expected: string,
      next: Ledger,
      message: string,
    ): Promise<boolean>;
  } | null;
  readLocal(
    source: 'local-account' | 'guest',
    family: DataFamily,
  ): Promise<{ family: DataFamily; ledger: Ledger | null }>;
  refreshAccount(): Promise<unknown>;
  retryOperation(family: DataFamily, token: string): Promise<boolean>;
  files: any;
  newId(): string;
}): CloudWalletController;
