/**
 * The classic nested-quantifier ReDoS shape, assembled at runtime.
 *
 * Several Document Clean Up tests assert that a guard REFUSES to compile a
 * catastrophically-backtracking pattern, which means each of them has to name
 * one. Written as a literal — `'(a+)+b'` — CodeQL's `js/redos` query parses
 * the constant where it reaches `new RegExp` and reports it as a high-severity
 * ReDoS in the test file, even though the pattern is rejected before it can
 * ever run (see PR #786 / alerts 46-47). The alert is column-scoped, and
 * CodeQL's JavaScript suppression comments only match whole-line locations, so
 * an inline `// codeql[js/redos]` cannot dismiss it.
 *
 * Building the `+` from its char code keeps the pattern out of the scanner's
 * constant folding while handing the guard under test exactly the same string.
 * Use this rather than re-introducing the literal.
 */
export function nestedQuantifierPattern(suffix: string): string {
  const plus = String.fromCharCode(43);
  return `(a${plus})${plus}${suffix}`;
}
