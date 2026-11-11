# Contributing to Penmoss

Thanks for helping. Penmoss is a small project with one maintainer, so a short issue first saves everyone time on anything bigger than a fix.

## Reporting bugs and ideas

- **Bugs and feature requests:** open an [issue](https://github.com/htxryan/penmoss/issues/new/choose), or use **Send feedback** in the app, which attaches the version and where you were. Each new issue is copied into the maintainer's tracker (Linear) for triage, so you don't need an account there; the conversation stays on GitHub.
- **Security issues:** report them privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Building from source

You need Node 24, [Task](https://taskfile.dev) 3 and pnpm through Corepack:

```sh
git clone https://github.com/htxryan/penmoss
cd penmoss
corepack enable pnpm
task setup   # pnpm install
task dev     # the Mac app from this checkout
```

`task --list` shows every command, including the Android app's. How the code fits together is in [`docs/architecture.md`](docs/architecture.md).

## Making a change

1. Fork the repository and make your change on a branch.
2. Add a test that fails without the change. The kinds of test, and where they live, are in [`docs/development.md`](docs/development.md#testing).
3. Run `task check` (lint, typecheck and unit tests) and, for anything in the web app, `task e2e`.
4. Open a pull request that says what changes for someone using Penmoss and how you checked it. Fill in its **Release note**: one line per change people would notice, such as `Fixed: Search finds notes with accents.`, or `none`. The template shows the form, and a check says what to fix. If it changes a decision in [`docs/decisions.md`](docs/decisions.md), update that row in the same pull request.

The code style is in [`docs/development.md`](docs/development.md#code-style): pure functions in `packages/core`, every user action through the command registry, every colour through a theme token, no default exports.

## Pull requests from forks

CI's tests run on GitHub's hosted runners. A pull request from a fork runs them once a maintainer has read the change and approved the run; the jobs that run on the maintainer's own Macs (the performance budgets, and the signed builds on `main`) never run for a fork. A fork's pull request is merged through a branch in this repository: a maintainer pushes your change there, where every job runs, and links that pull request from yours. Your commits and authorship are kept. The details are in [`docs/ci.md` §9](docs/ci.md#9-pull-requests-from-forks).

## Code of Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
