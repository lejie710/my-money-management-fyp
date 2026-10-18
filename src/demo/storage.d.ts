import { Ledger } from './ledger';
export const STORAGE_KEY: string;
export function createLedgerStorage(adapter: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }): {
  load(): Promise<Ledger | null>;
  save(ledger: Ledger): Promise<Ledger>;
};
