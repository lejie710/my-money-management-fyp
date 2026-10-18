import { Ledger } from './model';

export type TransitionResult = { ok: boolean; pending: boolean; message?: string };
export type LedgerTransitionGuard = {
  prepare(current: Ledger, next: Ledger): Promise<TransitionResult>;
  resume(current: Ledger): Promise<TransitionResult>;
};
export type CommitLedgerResult = {
  ok: boolean;
  ledger: Ledger;
  blocked: boolean;
  message: string;
};
export function commitLedger(options: {
  current: Ledger;
  next: Ledger;
  storage: {
    save(ledger: Ledger): Promise<Ledger>;
    readCurrent(): Promise<Ledger | null>;
  };
  transition?: LedgerTransitionGuard | null;
}): Promise<CommitLedgerResult>;
