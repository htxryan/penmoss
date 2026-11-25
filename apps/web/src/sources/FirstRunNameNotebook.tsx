/** The first run's Name Your Notebook screen (6.x), and the name field Create New Repo shares (FirstRunRepos.tsx has the other screens). */
import { useId, useState } from 'react';
import { type Place } from './first-run-flow';
import { Action, Frame, LinkButton, PlaceCard } from './FirstRunFrame';
import { freeName, nameClash, useOtherNotebookNames } from './notebook-names';

/** The notebook name field, with a word when another notebook here has the name. */
export function NameField({
  value,
  onChange,
  testId,
  placeholder,
}: {
  value: string;
  onChange: (name: string) => void;
  testId: string;
  placeholder?: string;
}) {
  const others = useOtherNotebookNames();
  const twin = nameClash(value, others);
  const suggestion = freeName(value, others);
  return (
    <label className="settings-field fr-field">
      <span>Notebook name</span>
      <input
        className="input"
        maxLength={80}
        required
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {twin ? (
        // Allowed, but agents can't tell two notebooks with one name apart (Ryan's review of #192).
        <span className="fr-warn" role="status" data-testid="notebook-name-clash">
          Another notebook on this Mac is called {twin}.{' '}
          <LinkButton
            data-event="firstrun.name.use-suggestion"
            testId="notebook-name-clash-use"
            onClick={() => onChange(suggestion)}
          >
            Use {suggestion}
          </LinkButton>
        </span>
      ) : null}
    </label>
  );
}

/** Name Your Notebook (6.1, 6.2): only when a new notebook is made. */
export function NameNotebook({
  place,
  onMake,
  back,
}: {
  place: Place;
  onMake: (name: string) => void;
  back: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(place.suggested);
  return (
    <Frame
      name="name"
      step={3}
      title="Name Your Notebook"
      back={back}
      actions={
        <Action
          data-event="firstrun.name.make-notebook"
          primary
          form={formId}
          disabled={!name.trim()}
          testId="first-run-make"
        >
          Make Notebook
        </Action>
      }
    >
      <p className="fr-lead">It shows in the sidebar. Rename it any time.</p>
      <form
        id={formId}
        className="fr-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onMake(name.trim());
        }}
      >
        <NameField value={name} onChange={setName} testId="first-run-name-input" />
      </form>
      <PlaceCard label={place.label} dir={place.dir} branch={place.branch} />
    </Frame>
  );
}
