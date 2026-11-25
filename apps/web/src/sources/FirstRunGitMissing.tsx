/** The first run's Penmoss Needs Git screen (2.8; FirstRunRepos.tsx has the others). */
import { Action, Frame } from './FirstRunFrame';

/** Penmoss Needs Git (2.8): git, or the Mac's command-line tools it comes with, is missing. */
export function GitMissing({ back }: { back: () => void }) {
  return (
    <Frame
      name="git-missing"
      step={2}
      title="Penmoss Needs Git"
      back={back}
      actions={
        <Action
          data-event="firstrun.git-missing.try-again"
          primary
          icon="refresh"
          testId="first-run-retry"
          onClick={back}
        >
          Try Again
        </Action>
      }
    >
      <p className="fr-lead">git needs the Mac’s command-line tools.</p>
      <p className="fr-lead fr-small">
        In Terminal, run <code>xcode-select --install</code> to open Apple’s installer. It takes a
        few minutes; then Try Again.
      </p>
    </Frame>
  );
}
