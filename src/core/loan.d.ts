/** annualRateUnits is one ten-thousandth of one percentage point: 12% = 120000. */
export type LoanInputs = { principalMinor: number; annualRateUnits: number; termMonths: number };
export type LoanPayment = {
  month: number;
  openingBalanceMinor: number;
  paymentMinor: number;
  interestMinor: number;
  principalPaidMinor: number;
  closingBalanceMinor: number;
};
export type LoanResult = {
  calculationVersion: 'fixed-rate-monthly-v1';
  inputs: LoanInputs;
  regularPaymentMinor: number;
  finalPaymentMinor: number;
  totalPaidMinor: number;
  totalInterestMinor: number;
  requestedTermMonths: number;
  actualTermMonths: number;
  paidOffEarly: boolean;
  schedule: LoanPayment[];
};
export const CALCULATION_VERSION: 'fixed-rate-monthly-v1';
export const MAX_PRINCIPAL_MINOR: number;
export const RATE_SCALE: 10000;
export const MAX_ANNUAL_RATE_UNITS: 1000000;
export const MAX_TERM_MONTHS: 600;
export function parseAnnualRate(text: string): number;
/** Plain input text without a percent sign or unnecessary trailing zeros. */
export function formatAnnualRate(annualRateUnits: number): string;
export function parseTermMonths(text: string): number;
/** Exact rational annuity, half-up minor-unit rounding, adjusted final payment; never persists. */
export function calculateLoan(inputs: LoanInputs): LoanResult;
