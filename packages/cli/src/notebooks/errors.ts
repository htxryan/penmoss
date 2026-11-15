/** A git notebook's failures as the CLI reports them: an exit code, the host's words, what to do. */
import { GitTransportError, NotebookError, privateEmailAdvice } from '@penmoss/git-notebook';
import { LockHeldError } from '@penmoss/git-notebook/node';
import { CliError, EXIT } from '../errors';

/**
 * The CLI's error for `error`. `adding`: it ended a `notebook add`, which rolled back, so advice
 * names add again, never a command on the notebook that is not there (#198).
 */
export function cliError(error: unknown, name: string, adding = false): unknown {
  if (error instanceof GitTransportError) {
    const exit =
      error.code === 'auth'
        ? EXIT.AUTH
        : error.code === 'not_found'
          ? EXIT.NOT_FOUND
          : error.code === 'protected' || error.code === 'rules' || error.code === 'refused'
            ? EXIT.REFUSED
            : EXIT.ERROR;
    const hints: string[] = [];
    if (error.hostMessage) hints.push(...error.hostMessage.split('\n').map((line) => `  ${line}`));
    if (error.code === 'auth') {
      hints.push(
        `Check git's credentials for this host, or save a personal access token: penmoss notebook token ${name} -`,
      );
    }
    if (error.code === 'signing') {
      hints.push(`To commit unsigned from now on: penmoss notebook set ${name} --no-sign`);
    }
    if (error.code === 'host_key') {
      hints.push(
        'Check the host key: connect once with ssh to the host and compare its fingerprint with the one the host publishes, then try again.',
      );
    }
    const said = error.hostMessage ?? error.message;
    if (adding) {
      if (privateEmailAdvice(said, '')) {
        hints.push(
          "GitHub refused the push: its commits would make your private email address public (GH007). Nothing was added: run the same penmoss notebook add again with --author-email <that address>, your GitHub no-reply address (the one ending in @users.noreply.github.com in GitHub's Settings → Emails).",
        );
      }
    } else {
      const advice = privateEmailAdvice(
        said,
        `penmoss notebook set ${name} --author-email <that address>`,
      );
      if (advice) hints.push(advice);
    }
    if (
      !adding &&
      (error.code === 'protected' || error.code === 'rules' || error.code === 'refused')
    ) {
      hints.push(
        'Nothing is lost: the changes stay here and go with the next sync that is allowed.',
      );
    }
    return new CliError(exit, error.message, `git_${error.code}`, undefined, hints);
  }
  if (error instanceof NotebookError) {
    const exit =
      error.code === 'no_notebook'
        ? EXIT.NOT_FOUND
        : error.code === 'busy'
          ? EXIT.ERROR
          : EXIT.REFUSED;
    const hints =
      error.code === 'branch_gone'
        ? [
            `If the branch was renamed, add the notebook again with --branch <the new name> (remove this one first: penmoss notebook remove ${name}).`,
          ]
        : [];
    return new CliError(exit, error.message, error.code, undefined, hints);
  }
  if (error instanceof LockHeldError)
    return new CliError(EXIT.CONFLICT, error.message, 'notebook_busy');
  return error;
}
