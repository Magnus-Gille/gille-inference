export interface AssertionAnalysis {
  assertionCallSites: number;
  subjectAssertionCallSites: number;
  subjectAssertionExecutions: number;
  minimum: number;
  pass: boolean;
}

export function analyzeAssertions(
  sourceText: string,
  subject: string,
  minimum: number,
  file?: string,
): AssertionAnalysis;
