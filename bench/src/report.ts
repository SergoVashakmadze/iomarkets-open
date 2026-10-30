// What the Test Bench reports. Codes are stable: tests, the GitHub Action and agents key on them.

export type Severity = 'error' | 'warning';

export type Issue = {
  severity: Severity;
  /** 'schema' for XSD checks, 'rule' for business rules. */
  layer: 'schema' | 'rule';
  code: string;
  /** Element path, e.g. /Document/FIToFICstmrCdtTrf/CdtTrfTxInf[2]/IntrBkSttlmAmt. */
  path: string;
  line: number;
  /** The reason in plain English. */
  message: string;
};

export type Report = {
  /** True when there are no errors (warnings allowed). */
  valid: boolean;
  /** Message identifier found, e.g. pacs.008.001.08, or null if it couldn't be told. */
  message: string | null;
  /** What it is, e.g. "FI to FI customer credit transfer". */
  title: string | null;
  errors: number;
  warnings: number;
  issues: Issue[];
  /** True when issues were cut off at the limit. */
  truncated: boolean;
  checked: { schema: boolean; rules: boolean };
};

export const MAX_ISSUES = 200;
