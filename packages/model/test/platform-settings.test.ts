/**
 * Per-platform settings (PEN-156, A1605): the Macs and the phones each keep their own copy of the
 * look and layout beside the shared device map, falling back to the shared value while they have
 * none.
 */
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_MAP,
  deviceSettings,
  mergedSettings,
  readSettings,
  setSetting,
  writeSetting,
} from '../src/workspace';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('per-platform settings (A1605)', () => {
  it('shows the shared value on a platform with no copy of its own', () => {
    const doc = new Y.Doc();
    setSetting(doc, DEVICE_MAP, 'theme.id', 'nord');
    setSetting(doc, DEVICE_MAP, 'sidebar.hiddenSections', ['tags']);
    expect(deviceSettings(doc, 'desktop')['theme.id']).toBe('nord');
    expect(deviceSettings(doc, 'mobile')['sidebar.hiddenSections']).toEqual(['tags']);
  });

  it('keeps a change on the Mac off the phones, and the shared value as it was', () => {
    const mac = new Y.Doc();
    const phone = new Y.Doc();
    setSetting(mac, DEVICE_MAP, 'theme.id', 'nord');
    sync(mac, phone);

    writeSetting(mac, 'theme.id', 'paper', null, 'desktop');
    writeSetting(phone, 'sidebar.sectionOrder', ['tags', 'recent'], null, 'mobile');
    writeSetting(phone, 'keys.app.search', ['Mod+J'], null, 'mobile');
    sync(mac, phone);

    expect(deviceSettings(mac, 'desktop')['theme.id']).toBe('paper');
    expect(deviceSettings(phone, 'mobile')['theme.id']).toBe('nord');
    expect(readSettings(mac, DEVICE_MAP)['theme.id']).toBe('nord');
    expect(deviceSettings(phone, 'mobile')['sidebar.sectionOrder']).toEqual(['tags', 'recent']);
    expect(deviceSettings(mac, 'desktop')).not.toHaveProperty('sidebar.sectionOrder');
    expect(deviceSettings(mac, 'desktop')).not.toHaveProperty('keys.app.search');
    expect(deviceSettings(phone, 'mobile')['keys.app.search']).toEqual(['Mod+J']);
  });

  it('keeps shared settings shared on every platform', () => {
    const mac = new Y.Doc();
    const phone = new Y.Doc();
    writeSetting(mac, 'quickAccess.notes', ['01A'], null, 'desktop');
    writeSetting(mac, 'symbols.list', [], null, 'desktop');
    writeSetting(mac, 'theme.custom.ink', { id: 'ink' }, null, 'desktop');
    writeSetting(mac, 'timeZone', 'Asia/Tokyo', null, 'desktop');
    sync(mac, phone);
    const shown = mergedSettings(phone, 'mobile');
    expect(shown['quickAccess.notes']).toEqual(['01A']);
    expect(shown['symbols.list']).toEqual([]);
    expect(shown['theme.custom.ink']).toEqual({ id: 'ink' });
    expect(shown['timeZone']).toBe('Asia/Tokyo');
    expect(readSettings(mac, 'desktop')).toEqual({});
  });

  it('puts a platform back to the default, whatever the shared value is', () => {
    const doc = new Y.Doc();
    setSetting(doc, DEVICE_MAP, 'font.noteSize', 18);
    writeSetting(doc, 'font.noteSize', undefined, null, 'desktop');
    expect(deviceSettings(doc, 'desktop')).not.toHaveProperty('font.noteSize');
    expect(deviceSettings(doc, 'mobile')['font.noteSize']).toBe(18);
    expect(readSettings(doc, DEVICE_MAP)['font.noteSize']).toBe(18);
  });

  it('reads and writes the shared map alone without a platform, as agents and older apps do', () => {
    const doc = new Y.Doc();
    writeSetting(doc, 'theme.id', 'slate', null, 'mobile');
    writeSetting(doc, 'theme.id', 'gruvbox');
    expect(deviceSettings(doc)['theme.id']).toBe('gruvbox');
    expect(deviceSettings(doc, 'mobile')['theme.id']).toBe('slate');
  });

  it('ignores a key in a platform map that is not a per-platform one', () => {
    const doc = new Y.Doc();
    setSetting(doc, DEVICE_MAP, 'symbols.list', []);
    setSetting(doc, 'mobile', 'symbols.list', [{ glyph: '★' }]);
    expect(deviceSettings(doc, 'mobile')['symbols.list']).toEqual([]);
  });
});
