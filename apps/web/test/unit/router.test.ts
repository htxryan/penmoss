import { describe, expect, it } from 'vitest';
import { isPlainLeftClick, notePath, parseRoute } from '../../src/router';

const ID = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';

describe('parseRoute', () => {
  it('maps the app paths', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/graph')).toEqual({ name: 'graph' });
    expect(parseRoute('/trash')).toEqual({ name: 'trash' });
  });

  // T59 (D49): the server's pages went with it.
  it('has no devices, link, sign-in, sync or mirror pages', () => {
    for (const path of [
      '/settings/devices',
      '/link',
      '/native-sign-in',
      '/settings/sync',
      '/settings/git-mirror',
    ]) {
      expect(parseRoute(path), path).toEqual({ name: 'not-found' });
    }
  });

  it('opens Settings on Appearance, first on every client (T39 pass 3, A551)', () => {
    expect(parseRoute('/settings')).toEqual({ name: 'settings', section: 'appearance' });
    expect(parseRoute('/settings/')).toEqual({ name: 'settings', section: 'appearance' });
    expect(parseRoute('/settings/shortcuts')).toEqual({ name: 'settings', section: 'shortcuts' });
    // A git notebook's own page, and Agents (A1098); no other section has pages of its own.
    expect(parseRoute('/settings/agents')).toEqual({ name: 'settings', section: 'agents' });
    expect(parseRoute('/settings/git-notebooks/01M6F03GY028BT0CNQR1YRC2TE')).toEqual({
      name: 'settings',
      section: 'git-notebooks',
      item: '01M6F03GY028BT0CNQR1YRC2TE',
    });
    // A notebook's agents, on a page of their own too (A1125).
    expect(parseRoute('/settings/agents/01M6F03GY028BT0CNQR1YRC2TE')).toEqual({
      name: 'settings',
      section: 'agents',
      item: '01M6F03GY028BT0CNQR1YRC2TE',
    });
    expect(parseRoute('/settings/shortcuts/01M6F03GY028BT0CNQR1YRC2TE').name).toBe('not-found');
    expect(parseRoute('/settings/git-notebooks/nope').name).toBe('not-found');
  });

  it('opens notes by ULID, with or without a trailing slash', () => {
    expect(parseRoute(`/notes/${ID}`)).toEqual({ name: 'note', id: ID });
    expect(parseRoute(`/notes/${ID}/`)).toEqual({ name: 'note', id: ID });
    expect(parseRoute(notePath(ID))).toEqual({ name: 'note', id: ID });
  });

  it('rejects anything else', () => {
    expect(parseRoute('/notes/')).toEqual({ name: 'not-found' });
    expect(parseRoute('/notes/not-a-ulid')).toEqual({ name: 'not-found' });
    expect(parseRoute(`/notes/${ID.toLowerCase()}`)).toEqual({ name: 'not-found' });
    expect(parseRoute(`/notes/${ID}/extra`)).toEqual({ name: 'not-found' });
    expect(parseRoute('/elsewhere')).toEqual({ name: 'not-found' });
    // A malformed escape is not a note (decodeURIComponent would throw during render).
    expect(parseRoute('/notes/%E0')).toEqual({ name: 'not-found' });
    expect(parseRoute('/notes/%')).toEqual({ name: 'not-found' });
  });
});

describe('isPlainLeftClick', () => {
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it('handles plain left clicks in the app', () => {
    expect(isPlainLeftClick(click)).toBe(true);
  });

  it('leaves new-tab, new-window and other clicks to the browser', () => {
    expect(isPlainLeftClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...click, defaultPrevented: true })).toBe(false);
  });
});
