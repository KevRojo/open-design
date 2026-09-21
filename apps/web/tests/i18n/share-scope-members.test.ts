import { describe, expect, it } from 'vitest';
import { zhCN } from '../../src/i18n/locales/zh-CN';
import { zhTW } from '../../src/i18n/locales/zh-TW';

describe('Chinese workspace scope member labels', () => {
  it.each([
    { locale: 'zh-CN', dict: zhCN, label: '团队成员', oldLabel: '工作空间成员' },
    { locale: 'zh-TW', dict: zhTW, label: '團隊成員', oldLabel: '工作空間成員' },
  ])('$locale matches the canvas and its private-state instruction', ({ dict, label, oldLabel }) => {
    expect(dict['fileViewer.workspaceAccessMembers']).toBe(label);
    expect(dict['fileViewer.workspaceSharePrivateDescription']).toContain(label);
    expect(dict['fileViewer.workspaceSharePrivateDescription']).not.toContain(oldLabel);
  });
});
