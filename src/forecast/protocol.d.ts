import type { Currency } from '../core/model';
import type { ExpenseForecast } from '../core/forecast';
export type ForecastInput = Readonly<{
  version: 'recorded-expense-prophet-v1';
  currency: Currency;
  asOfDate: string;
  history: readonly Readonly<{ month: string; expenseMinor: number }>[];
  targetMonths: readonly string[];
}>;
export type ForecastWire = ForecastInput & Readonly<{ requestId: string }>;
export type ProphetResponse = Readonly<{
  version: 'recorded-expense-prophet-v1';
  requestId: string;
  provider: 'prophet';
  currency: Currency;
  asOfDate: string;
  trainingThroughMonth: string;
  trainingMonths: number;
  predictionUnit: 'currency-minor-unit';
  rounding: 'half-away-from-zero';
  negativePredictionPolicy: 'preserve-and-label';
  hasNegativePredictions: boolean;
  intervals: null;
  settings: Readonly<Record<string, string | number | boolean>>;
  forecast: readonly Readonly<{ month: string; lead: number; predictedMinor: number }>[];
}>;
export const VERSION: 'recorded-expense-prophet-v1';
export const MAX_MONEY: number;
export const MESSAGES: Readonly<Record<string, string>>;
export const SETTINGS: Readonly<Record<string, string | number | boolean>>;
export class ForecastError extends Error {
  readonly code: string;
  constructor(code: string);
}
export function requestId(value: unknown): boolean;
export function validateInput(value: unknown): ForecastInput;
export function validateWire(value: unknown): ForecastWire;
export function inputFromForecast(value: ExpenseForecast): ForecastInput;
export function validateResult(value: unknown, request: ForecastWire): ProphetResponse;
