import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('S1-T2 scope option rows', () => {
  it('declares compact rows and neutral selected/hover feedback', () => {
    const css = postcss.parse(readFileSync(resolve('src/components/share/ShareTab.module.css'), 'utf8'));
    const declarations = (selector: string) => {
      const values: Record<string, string> = {};
      css.walkRules(selector, rule => { rule.walkDecls(decl => { values[decl.prop] = decl.value; }); });
      return values;
    };
    expect(declarations('.panel :global(.chrome-access-options button)')).toMatchObject({
      'box-sizing': 'border-box', height: '28px', 'min-height': '28px', padding: '0 8px',
      gap: '8px', border: '0', 'border-radius': '4px', color: '#494949', 'font-size': '12px', 'font-weight': '400',
    });
    for (const state of ['[aria-selected="true"]', ':hover:not(:disabled)']) {
      expect(declarations(`.panel :global(.chrome-access-options button${state})`)).toMatchObject({
        background: '#F2F2F4', color: '#1F1F1F',
      });
    }
  });
});

describe('S1-T/S4-T shared scope trigger', () => {
  it('uses the compact canvas trigger only under ShareTab', () => {
    const css = postcss.parse(readFileSync(resolve('src/components/share/ShareTab.module.css'), 'utf8'));
    const values: Record<string, string> = {};
    css.walkRules('.panel :global(.chrome-access-trigger)', rule => {
      rule.walkDecls(decl => { values[decl.prop] = decl.value; });
    });
    expect(values).toMatchObject({
      'box-sizing': 'border-box', display: 'flex', 'align-items': 'center',
      'justify-content': 'space-between', width: 'fit-content', 'min-width': '88px',
      height: '28px', 'min-height': '28px', padding: '0 8px', border: '0',
      'border-radius': '5px', background: '#F6F6F6', color: '#555555',
      'font-size': '12px', gap: '8px',
    });
  });
});
