export function createGuardedAuthPersistence(
  adapter: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
  },
  options: { prefix: string; sessionKey: string },
): {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  preflight(): Promise<void>;
  confirm(expectedBytes: string | null): Promise<boolean>;
  finishInitialization(expectedBytes: string | null): Promise<boolean>;
  getState(): Readonly<{
    phase: 'hydrating' | 'ready';
    blocked: boolean;
    revision: number;
    probeReady: boolean;
    sessionObserved: boolean;
    initialHadSession: boolean;
  }>;
  subscribe(listener: () => void): () => void;
  drain(): Promise<void>;
};
