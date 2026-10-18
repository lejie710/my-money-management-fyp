import { StorageAdapter } from "../core/storage";
import { DataFamily } from "./identity";
export type LocalProfileExtras = {
  gender: "" | "female" | "male" | "nonbinary" | "prefer-not-to-say";
  birthDate: string | null;
};
export const GENDERS: readonly LocalProfileExtras["gender"][];
export const EMPTY_PROFILE_EXTRAS: Readonly<LocalProfileExtras>;
export function validateProfileExtras(
  value: unknown,
  today: string,
): LocalProfileExtras;
export function createProfileStore(
  adapter: StorageAdapter,
  family: DataFamily,
  today: () => string,
): {
  key: string;
  load(): Promise<LocalProfileExtras | null>;
  save(
    extras: LocalProfileExtras,
  ): Promise<{
    ok: boolean;
    pending: boolean;
    extras: LocalProfileExtras | null;
    message: string;
  }>;
};
