import assert from 'node:assert/strict';

import { test } from 'vitest';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { buildSyntaxClassCss, buildSyntaxTheme } from '@/modules/chat/utils/syntaxHighlightTheme';
import type { PrismStyleSheet } from '@/modules/chat/utils/syntaxHighlightTheme';

/**
 * The variable theme must be a lossless re-encoding of the two Prism themes:
 * resolving its variables with the `:root` block has to reproduce oneLight
 * exactly, and with the `.dark` block oneDark exactly. Otherwise the toggle
 * would be fast but the colours would drift.
 */

const parseDeclarations = (css: string, blockSelector: string): Map<string, string> => {
  const block = new RegExp(`${blockSelector}\\{([^}]*)\\}`).exec(css);
  assert.ok(block, `expected a ${blockSelector} block`);

  const declarations = new Map<string, string>();
  for (const declaration of block[1].split(';')) {
    if (!declaration.trim()) {
      continue;
    }
    const separator = declaration.indexOf(':');
    declarations.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1));
  }
  return declarations;
};

const resolve = (
  style: PrismStyleSheet,
  variables: Map<string, string>,
): PrismStyleSheet => {
  const resolved: PrismStyleSheet = {};

  for (const [selector, rule] of Object.entries(style)) {
    const resolvedRule: Record<string, string> = {};
    for (const [property, value] of Object.entries(rule)) {
      const variableMatch = /^var\((--[\w-]+)\)$/.exec(value);
      if (!variableMatch) {
        resolvedRule[property] = value;
        continue;
      }
      const variableValue = variables.get(variableMatch[1]);
      // An undefined variable makes the declaration invalid, i.e. unset.
      if (variableValue !== undefined) {
        resolvedRule[property] = variableValue;
      }
    }
    resolved[selector] = resolvedRule;
  }

  return resolved;
};

const theme = buildSyntaxTheme(oneLight as PrismStyleSheet, oneDark as PrismStyleSheet);

test('the light variables reproduce oneLight exactly', () => {
  const resolved = resolve(theme.style, parseDeclarations(theme.css, ':root'));
  assert.deepEqual(resolved, oneLight);
});

test('the dark variables reproduce oneDark exactly', () => {
  const resolved = resolve(theme.style, parseDeclarations(theme.css, '\\.dark'));
  assert.deepEqual(resolved, oneDark);
});

test('no theme-dependent value is left as a literal colour', () => {
  // Any literal that differs between the themes would need the style prop to be
  // swapped again, which is what re-tokenized every block on a theme toggle.
  for (const [selector, rule] of Object.entries(theme.style)) {
    for (const [property, value] of Object.entries(rule)) {
      const lightValue = (oneLight as PrismStyleSheet)[selector]?.[property];
      const darkValue = (oneDark as PrismStyleSheet)[selector]?.[property];
      if (lightValue === darkValue) {
        continue;
      }
      assert.match(
        value,
        /^var\(--cc-syntax-\d+\)$/,
        `${selector}.${property} differs between themes but is not a variable`,
      );
    }
  }
});

test('properties shared by both themes stay literal instead of becoming variables', () => {
  // fontFamily is the same in both themes and must not cost a variable.
  const codeRule = theme.style['code[class*="language-"]'];
  assert.ok(codeRule.fontFamily);
  assert.ok(
    !codeRule.fontFamily.startsWith('var('),
    'identical values must not be turned into variables',
  );
});

test('theme-dependent colours are emitted as variables', () => {
  const preRule = theme.style['pre[class*="language-"]'];
  assert.match(preRule.background, /^var\(--cc-syntax-\d+\)$/);
});

test('the class rules carry exactly the rules the inline mode applies', () => {
  const css = buildSyntaxClassCss(theme.style, '.scope');
  const rules = new Map(
    css.split('\n').map((rule) => {
      const open = rule.indexOf('{');
      return [rule.slice(0, open), rule.slice(open + 1, -1)] as const;
    }),
  );

  const kebab = (property: string) =>
    property.replace(/^(Moz|O|Webkit|ms)(?=[A-Z])/, (prefix) => `-${prefix.toLowerCase()}`)
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const declarations = (rule: Record<string, string>) =>
    Object.entries(rule).map(([property, value]) => `${kebab(property)}:${value};`).join('');

  // The inline mode styles a token by its class names and the <pre> by this one key.
  const tokenKeys = Object.keys(theme.style).filter((key) => /^[\w-]+(?:\.[\w-]+)*$/.test(key));
  assert.ok(tokenKeys.includes('keyword'));
  for (const key of tokenKeys) {
    assert.equal(rules.get(`.scope .${key}`), declarations(theme.style[key]), key);
  }
  assert.equal(
    rules.get('.scope pre.prismjs'),
    declarations(theme.style['pre[class*="language-"]']),
  );
  assert.equal(rules.size, tokenKeys.length + 1, 'no rule for a selector the inline mode never applied');
  assert.match(rules.get('.scope pre.prismjs') ?? '', /-moz-tab-size:2;/);
});
