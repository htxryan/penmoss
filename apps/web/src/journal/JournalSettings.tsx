import { fillTemplate, longDate, type PeriodKind } from '@penmoss/core/periodic';
import { templateOf, templateSetting, TIME_ZONE_SETTING, timeZoneOf } from '@penmoss/core/settings';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { desktop } from '../desktop/bridge';
import { Menu, MenuItem } from '../shell/Menu';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { thisWeek, today } from './journal';
import { PLACEHOLDERS, previewLines } from './template-preview';
import { utcOffset, zoneName } from './time-zones';
import { TimeZonePicker } from './TimeZonePicker';
import { SettingRow } from '../theme/look-rows';
import './writing.css';

/** Half a second after the last key, as the theme editor saves (A417). */
const SAVE_DELAY_MS = 500;

const TEMPLATE_TABS: ReadonlyArray<{
  readonly kind: PeriodKind;
  readonly label: string;
  readonly setting: string;
  readonly preview: string;
}> = [
  { kind: 'daily', label: 'Daily Template', setting: 'daily-template', preview: 'Today’s Note' },
  {
    kind: 'weekly',
    label: 'Weekly Template',
    setting: 'weekly-template',
    preview: 'This Week’s Note',
  },
];

/**
 * Settings → Daily Notes (T19; PEN-146 option B): the time zone that decides which day "today"
 * is (A77), found in a searchable picker, and the daily and weekly templates (A78) as tabs over
 * one editor, beside a preview of the note the template makes for today or this week, filled in
 * by the same `fillTemplate` that makes the note. A template saves as you type, half a second
 * after the last key, as the theme editor does (A417), instead of A78's Save button; Reset to
 * Default removes the setting. All of it is the Primary Notebook's, so it syncs (A827). Quick
 * Capture's default moved to its own page (QuickCaptureSettings).
 */
export function JournalSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const settings = workspace.settings();
  const id = useId();
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="journal-settings"
    >
      <h2 id={`${id}-h`}>Daily Notes</h2>
      <p>
        A note for each day and each week, made from these templates. The time zone and the
        templates are kept in your Primary Notebook, chosen in Settings → All Notebooks, and sync to
        your other devices.
      </p>
      <div className="lf-group">
        <TimeZoneRow settings={settings} />
      </div>
      <TemplateEditor settings={settings} />
    </section>
  );
}

function TimeZoneRow({ settings }: { readonly settings: Record<string, unknown> }) {
  const workspace = useWorkspace();
  const zone = timeZoneOf(settings);
  const day = today(settings);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const offset = utcOffset(zone);
  return (
    <SettingRow
      setting="time-zone"
      label="Time Zone"
      labelId={`${id}-label`}
      help={`Today is ${longDate(day)}. Kept in your Primary Notebook, so every device agrees on the day.`}
      helpId={`${id}-help`}
      testId="time-zone-setting"
      data-today={day.toString()}
      data-zone={zone}
    >
      <button
        ref={button}
        id={`${id}-zone`}
        type="button"
        className="btn wr-zone"
        data-ui="menu"
        aria-haspopup="dialog"
        aria-labelledby={`${id}-label ${id}-zone`}
        aria-describedby={`${id}-help`}
        onClick={() => setOpen(true)}
      >
        <Icon name="search" size={14} />
        <span>
          {zoneName(zone)}
          {offset ? ` (${offset})` : ''}
        </span>
      </button>
      {open ? (
        <TimeZonePicker
          current={zone}
          deviceLabel={desktop() ? 'This Mac’s' : 'This Device’s'}
          onClose={close}
          onChoose={(next) => {
            workspace.setSetting(TIME_ZONE_SETTING, next);
            close();
          }}
        />
      ) : null}
    </SettingRow>
  );
}

function TemplateEditor({ settings }: { readonly settings: Record<string, unknown> }) {
  const workspace = useWorkspace();
  const id = useId();
  const [kind, setKind] = useState<PeriodKind>('daily');
  /** What is typed and not saved yet, by tab (absent: the editor shows the saved template). */
  const [drafts, setDrafts] = useState<Partial<Record<PeriodKind, string>>>({});
  const [status, setStatus] = useState<Partial<Record<PeriodKind, string>>>({});
  const pending = useRef(
    new Map<PeriodKind, { timer: ReturnType<typeof setTimeout>; text: string }>(),
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const tabs = useRef(new Map<PeriodKind, HTMLButtonElement>());

  // Leaving the page saves what was typed.
  useEffect(() => {
    const saves = pending.current;
    return () => {
      for (const [each, save] of saves) {
        clearTimeout(save.timer);
        workspace.setSetting(templateSetting(each), save.text);
      }
      saves.clear();
    };
  }, [workspace]);

  const tab = TEMPLATE_TABS.find((each) => each.kind === kind)!;
  const saved = templateOf(settings, kind);
  const value = drafts[kind] ?? saved;
  const period = kind === 'daily' ? today(settings).toString() : thisWeek(settings);
  const isSet = typeof settings[templateSetting(kind)] === 'string';

  const forget = (which: PeriodKind) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[which];
      return next;
    });

  const edit = (text: string) => {
    const which = kind;
    setDrafts((current) => ({ ...current, [which]: text }));
    setStatus((current) => ({ ...current, [which]: undefined }));
    const before = pending.current.get(which);
    if (before) clearTimeout(before.timer);
    const timer = setTimeout(() => {
      pending.current.delete(which);
      workspace.setSetting(templateSetting(which), text);
      forget(which);
      setStatus((current) => ({ ...current, [which]: 'Saved' }));
    }, SAVE_DELAY_MS);
    pending.current.set(which, { timer, text });
  };

  const reset = () => {
    const before = pending.current.get(kind);
    if (before) clearTimeout(before.timer);
    pending.current.delete(kind);
    workspace.setSetting(templateSetting(kind), undefined);
    forget(kind);
    setStatus((current) => ({ ...current, [kind]: 'Back to the default' }));
  };

  /** Puts `{{name}}` where the cursor is (over a selection), and the cursor after it. */
  const insert = (name: string) => {
    const field = textarea.current;
    const token = `{{${name}}}`;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    edit(value.slice(0, start) + token + value.slice(end));
    const caret = start + token.length;
    // After the menu closes and gives the focus back to its button.
    setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(caret, caret);
    }, 0);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TEMPLATE_TABS.findIndex((each) => each.kind === kind);
    const count = TEMPLATE_TABS.length;
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: (at + 1) % count,
      ArrowLeft: (at - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = TEMPLATE_TABS[to]!.kind;
    setKind(next);
    tabs.current.get(next)?.focus();
  };

  const lines = previewLines(fillTemplate(value, kind, period));
  return (
    <>
      <div className="wr-tabs" role="tablist" aria-label="Templates" onKeyDown={onTabKeyDown}>
        {TEMPLATE_TABS.map((each) => (
          <button
            key={each.kind}
            data-ui="option"
            ref={(element) => {
              if (element) tabs.current.set(each.kind, element);
              else tabs.current.delete(each.kind);
            }}
            type="button"
            role="tab"
            className="wr-tab"
            id={`${id}-tab-${each.kind}`}
            aria-selected={each.kind === kind}
            aria-controls={`${id}-panel`}
            tabIndex={each.kind === kind ? 0 : -1}
            data-setting={each.setting}
            data-testid={`template-tab-${each.kind}`}
            onClick={() => setKind(each.kind)}
          >
            {each.label}
          </button>
        ))}
      </div>
      <div
        className="wr-template"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${kind}`}
        data-testid="template-editor"
        data-kind={kind}
      >
        <div className="wr-template-editor">
          <div className="wr-template-tools">
            <div className="wr-placeholder-menu">
              <Menu
                label="Insert a Placeholder"
                icon="plus"
                text="Placeholder"
                className="btn quiet"
                testId="template-placeholder"
              >
                {PLACEHOLDERS.map((placeholder) => (
                  <MenuItem
                    key={placeholder.name}
                    icon={placeholder.name.includes('week') ? 'week' : 'calendar'}
                    data-testid={`placeholder-${placeholder.name}`}
                    onClick={() => insert(placeholder.name)}
                  >
                    {placeholder.label}
                    <span className="muted">
                      {fillTemplate(`{{${placeholder.name}}}`, kind, period)}
                    </span>
                  </MenuItem>
                ))}
              </Menu>
            </div>
            <span className="muted">
              Date, weekday, week, month and year, filled in for each note
            </span>
          </div>
          <textarea
            ref={textarea}
            className="input template-input"
            aria-labelledby={`${id}-tab-${kind}`}
            aria-describedby={`${id}-saved`}
            data-testid="template-input"
            spellCheck={false}
            value={value}
            onChange={(event) => edit(event.target.value)}
          />
        </div>
        <figure className="wr-preview" data-testid="template-preview">
          <figcaption className="wr-preview-label">{tab.preview}</figcaption>
          <p className="wr-preview-title">{period}</p>
          {lines.length === 0 ? (
            <p className="pv-empty">An empty note</p>
          ) : (
            lines.map((line, index) => (
              <p key={index} className={`pv-${line.kind === 'task' ? 'item' : line.kind}`}>
                {line.kind === 'task' ? `${line.done ? '☑' : '☐'} ` : null}
                {line.kind === 'item' ? `${line.marker} ` : null}
                {line.text}
              </p>
            ))
          )}
        </figure>
      </div>
      <div className="wr-template-foot">
        <span className="wr-saved" role="status" id={`${id}-saved`} data-testid="template-status">
          {status[kind] ? (
            <>
              {status[kind] === 'Saved' ? <Icon name="check" size={14} /> : null}
              {status[kind]}
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="btn quiet"
          data-ui="item"
          disabled={!isSet && drafts[kind] === undefined}
          onClick={reset}
        >
          <Icon name="undo" size={14} />
          Reset to Default
        </button>
      </div>
    </>
  );
}
