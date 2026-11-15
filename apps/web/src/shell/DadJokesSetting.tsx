import { useId } from 'react';
import { SettingRow, Switch } from '../theme/look-rows';
import { useDadJokes } from './dad-jokes-state';

/**
 * Dad Jokes: a joke in place of the empty window's heading (A1576), or Welcome to Penmoss. On
 * unless turned off; synced. A row of Settings → Appearance → Text.
 */
export function DadJokesSetting() {
  const { on, set, canChange } = useDadJokes();
  const id = useId();
  return (
    <SettingRow
      setting="dad-jokes"
      label="Dad Jokes"
      labelFor={id}
      help={<span>A joke in place of the heading when no note is open.</span>}
      helpId={`${id}-help`}
      testId="dad-jokes-setting"
    >
      <Switch
        id={id}
        checked={on}
        disabled={!canChange}
        aria-describedby={`${id}-help`}
        data-testid="dad-jokes"
        onChange={(event) => set(event.target.checked)}
      />
    </SettingRow>
  );
}
