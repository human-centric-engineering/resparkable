/**
 * Hand-rolled `next/navigation` router mocks — rules.
 *
 * WHY THIS EXISTS: `AppRouterInstance` gains required members between Next
 * minors — 16.3.0 added `bfcacheId` — and nothing type-checks a `vi.mock`
 * factory. A test that writes the router out by hand therefore keeps compiling
 * while handing the component under test an object the real router is no longer
 * shaped like. `createMockRouter()` (`tests/types/mocks.ts`) exists so there is
 * one place to add the next member; this check is what keeps the suite going
 * through it.
 *
 * Two invariants, both across every `.ts`/`.tsx` under `tests/` — `setup.ts`,
 * `helpers/` and `mocks/` included, not only `*.test.ts`:
 *
 * 1. **No object literal supplying all six router methods.** Six members means
 *    the author meant "a complete router", which is the factory's job. A
 *    minimal stub of two or three members, for a component that reads nothing
 *    else, is deliberately fine and is not flagged.
 * 2. **No cast that switches the type check off.** `useRouter as unknown as X`
 *    is strictly worse than an uncast literal, which at least fails loudly when
 *    the interface grows.
 *
 * ## Why this parses instead of pattern-matching
 *
 * The previous implementation was a regex-and-brace-matching scanner embedded
 * in `.claude/commands/pre-pr.md`, and it reported CLEAN on a suite holding 16
 * complete literals and 17 casts. Every one of its blind spots came from not
 * having a parser:
 *
 * - It collected members with `/([A-Za-z_$][\w$]*)\s*:/`, so a **shorthand**
 *   member (`refresh,` — no colon) was never counted. Ten files wrote `refresh`
 *   that way and five wrote `push`; all sixteen read as five-of-six and passed.
 * - It **anchored** on `prefetch\s*:` to find a literal at all, so a literal
 *   whose `prefetch` was shorthand would not even have been located.
 * - Its cast rule was a `grep` for the literal string
 *   `as unknown as ReturnType<typeof useRouter>`. Every real offender writes
 *   `as unknown as ReturnType<typeof vi.fn>` instead, which defeats the type
 *   check just as thoroughly.
 * - It needed a comment filter, because a JSDoc line mentioning the cast
 *   matched it.
 *
 * An AST has no such classes of bug. Shorthand is a node kind rather than a
 * spelling; `properties` is direct members only, so a nested literal cannot
 * contribute keys; comments are not nodes; and strings, template literals and
 * regex literals are single tokens, so code quoted inside them is not code.
 *
 * That last property is load-bearing for this module's own test, which holds
 * every violating shape as a template literal: the checker walking `tests/`
 * parses those as one `NoSubstitutionTemplateLiteral` and finds nothing. The
 * test needs no exemption, and a checker that has to exempt itself is the same
 * shape as the bug being fixed.
 *
 * Takes source *text*, not a path, so the rules stay testable without touching
 * the repo's real files.
 */

import ts from 'typescript';

/** The six members of `AppRouterInstance` a hand-rolled literal always writes. */
const ROUTER_METHODS = ['push', 'replace', 'refresh', 'back', 'forward', 'prefetch'] as const;

/** The factory every mock router is supposed to come from. */
const FACTORY = 'createMockRouter';

export type RouterMockRule = 'cast' | 'literal';

export interface RouterMockViolation {
  /** The path as given to {@link scanRouterMocks}, echoed for the report. */
  file: string;
  /** 1-based, as an editor counts. */
  line: number;
  column: number;
  rule: RouterMockRule;
  message: string;
}

export interface ScanOptions {
  /**
   * Suppresses the `literal` rule only.
   *
   * For `tests/types/mocks.ts`, which necessarily writes the complete router
   * out — it is the factory. The `cast` rule still applies there, deliberately:
   * a real cast added by a fork extending the factory is exactly what needs
   * catching, and the JSDoc mentioning one is a comment, so it is not a node.
   */
  allowCompleteLiteral?: boolean;
}

/**
 * `.tsx` must parse as TSX.
 *
 * Read as `ScriptKind.TS`, a JSX tag is a type assertion and the tree from
 * there on is nonsense — silently, with no error surfaced. Fifteen of the
 * sixteen files this check was written to catch are `.tsx`, so getting this
 * wrong would have reproduced the CLEAN it replaces.
 */
function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** The declared name of one object-literal member, or `null` if it has none. */
function memberName(member: ts.ObjectLiteralElementLike): string | null {
  // The entire bug the previous scanner had. Shorthand is not a spelling of a
  // key here; it is a distinct node with the same `name`.
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text;

  // A spread contributes no *declared* names. It can only add members, so it
  // never invalidates the superset test below and needs no bail-out.
  if (ts.isSpreadAssignment(member)) return null;

  const name = 'name' in member ? member.name : undefined;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  // `{ ['push']: … }` is the same member written the long way round.
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/** Whether the factory is called anywhere inside this literal. */
function usesFactory(literal: ts.ObjectLiteralExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === FACTORY) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(literal, visit);
  return found;
}

/** Unwraps casts, parens and `!` to reach the thing actually being cast. */
function innermostOperand(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** A cast expression, in either syntax. */
type CastExpression = ts.AsExpression | ts.TypeAssertion;

function isCast(node: ts.Node): node is CastExpression {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/**
 * `X as unknown as T` is two nested casts, and reporting both would double every
 * finding. The outer one is the whole expression, so the inner is skipped.
 */
function isInnerCastOfChain(node: CastExpression): boolean {
  const parent = node.parent;
  return parent !== undefined && isCast(parent) && parent.expression === node;
}

/**
 * Does this cast target the router?
 *
 * Two independent triggers, because the offenders in this repo trip only the
 * first and the documented invariant names only the second:
 *
 * - the thing being cast **is** `useRouter` (or `navigation.useRouter`), no
 *   matter what it is cast to — this is what catches
 *   `useRouter as unknown as ReturnType<typeof vi.fn>`;
 * - the target type names the router, no matter what is being cast — this is
 *   what catches `{} as unknown as ReturnType<typeof useRouter>`.
 *
 * Scoping to `useRouter` rather than banning `as unknown as ReturnType<typeof
 * vi.fn>` outright is not politeness. The suite has 104 of those casts and 87
 * are on something else entirely — `apiClient.post`, `useSearchParams`,
 * `headers`. A rule broad enough to catch the router ones flags all 87.
 */
function castTargetsRouter(node: CastExpression, sourceFile: ts.SourceFile): boolean {
  const operand = innermostOperand(node.expression).getText(sourceFile);
  if (operand === 'useRouter' || operand.endsWith('.useRouter')) return true;

  const target = node.type.getText(sourceFile);
  return /ReturnType\s*<\s*typeof\s+useRouter\s*>/.test(target) || target === 'AppRouterInstance';
}

/**
 * Every hand-rolled router mock in one file.
 *
 * Findings are returned in source order. The parse is a parse only — no
 * program, no type-checker, no `tsconfig` resolution — so this stays fast
 * enough to run over the whole suite on every `npm run validate`.
 */
export function scanRouterMocks(
  source: string,
  file: string,
  options: ScanOptions = {}
): RouterMockViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file)
  );

  const violations: RouterMockViolation[] = [];

  const at = (node: ts.Node): { line: number; column: number } => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: position.line + 1, column: position.character + 1 };
  };

  const visit = (node: ts.Node): void => {
    if (!options.allowCompleteLiteral && ts.isObjectLiteralExpression(node)) {
      const names = new Set(
        node.properties.map(memberName).filter((name): name is string => name !== null)
      );
      if (ROUTER_METHODS.every((method) => names.has(method)) && !usesFactory(node)) {
        violations.push({
          file,
          ...at(node),
          rule: 'literal',
          message:
            'Object literal supplies all six router methods by hand. ' +
            `Use \`${FACTORY}()\` from '@/tests/types/mocks' so the next member ` +
            'Next adds lands in one place.',
        });
      }
    }

    if (isCast(node) && !isInnerCastOfChain(node) && castTargetsRouter(node, sourceFile)) {
      violations.push({
        file,
        ...at(node),
        rule: 'cast',
        message:
          'Cast switches off the type check on a router mock. ' +
          `Use \`vi.mocked(useRouter)\` and \`${FACTORY}()\` instead — a cast ` +
          'hides a missing member rather than failing on it.',
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/** `path:line:col  message`, the shape an editor's jump-to-line understands. */
export function formatViolation(violation: RouterMockViolation): string {
  return `${violation.file}:${violation.line}:${violation.column}  [${violation.rule}] ${violation.message}`;
}
