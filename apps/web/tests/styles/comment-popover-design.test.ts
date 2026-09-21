import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'postcss';

describe('floating comment card surface', () => {
  it('uses the Owner-board opaque card without changing positioning or scrolling', () => {
    const css = parse(readFileSync(resolve(__dirname, '../../src/components/BoardComposerPopover.module.css'), 'utf8'));
    const values: Record<string, string> = {};
    css.walkRules('.surface:global(.comment-popover)', rule => {
      rule.walkDecls(decl => { values[decl.prop] = decl.value; });
    });
    expect(values).toMatchObject({
      padding: '12px', border: '1px solid #0000000D', 'border-radius': '10px',
      background: '#FFFFFF', 'box-shadow': '0 6px 24px #00000012',
      'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none',
    });
    for (const property of ['width', 'height', 'max-height', 'overflow', 'position', 'left', 'top']) {
      expect(values).not.toHaveProperty(property);
    }
  });
});
