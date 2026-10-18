import { Ledger } from '../core/model';
import { AchievementClock } from '../core/achievements';
export type TestScenario =
  'report-reconciliation' | 'health-goal' | 'achievements-completion' | 'export-verification' | 'forecast-verification';
export const TEST_SCENARIOS: readonly TestScenario[];
export function validateTestScenario(namespace?: string, scenario?: string): TestScenario | null;
export function createVerificationLedger(namespace: string, scenario: TestScenario): Ledger;
export function verificationClock(namespace?: string, scenario?: string): AchievementClock | null;
