const OBSERVATIONS = ['expected_success','expected_gate','wrong_gate','invalid_usage','unexpected_failure'];
export function verdict(expectation, observationClass) {
  if (!['must-block','must-escalate','must-allow'].includes(expectation) || !OBSERVATIONS.includes(observationClass)) return 'error';
  if (observationClass === 'wrong_gate' || observationClass === 'invalid_usage' || observationClass === 'unexpected_failure') return 'error';
  if (expectation === 'must-allow') return observationClass === 'expected_success' ? 'pass' : 'theater';
  return observationClass === 'expected_gate' ? 'pass' : 'bypass';
}
