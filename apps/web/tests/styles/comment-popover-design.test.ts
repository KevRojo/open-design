import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'postcss';

describe('floating comment card surface', () => {
  it('distinguishes editable and readonly notes without truncating content or removing focus treatment', () => {
    const css = parse(readFileSync(resolve(__dirname, '../../src/components/BoardComposerPopover.module.css'), 'utf8'));
    const declarations = (selector: string) => {
      const values: Record<string, string> = {};
      css.walkRules(selector, rule => { rule.walkDecls(decl => { values[decl.prop] = decl.value; }); });
      return values;
    };
    const note = declarations('.surface:global(.comment-popover) textarea');
    expect(note).toMatchObject({ padding: '8px 10px', 'border-radius': '6px', border: '1px solid #E3E3E6',
      background: '#FFFFFF', color: '#333333', 'font-size': '12px', 'line-height': '18px' });
    expect(declarations('.surface:global(.comment-popover) textarea[readonly]')).toMatchObject({
      background: '#F6F6F7', 'border-color': '#EFEFEF', color: '#666666',
    });
    for (const property of ['height', 'max-height', 'overflow', 'outline', 'pointer-events']) expect(note).not.toHaveProperty(property);
  });
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
