# Contributing to Quantic

Thanks for taking the time to contribute! This guide keeps changes reviewable and helps protect the existing application behavior.

## Before you start

- Read the project [README](README.md).
- Check open issues to avoid duplicating work.
- For substantial changes, open an issue first to discuss the approach.
- Never include passwords, API keys, tokens, database URLs, private user data, or production logs in a commit or issue.

## Development setup

The project has separate frontend and backend packages.

### Frontend

```bash
cd front-end
npm install
npm run dev
npm run build
```

### Backend

```bash
cd back-end
npm install
npm start
```

Configure the backend's required environment variables in a local `back-end/.env` file. Do not commit this file. See the README for additional setup notes.

## Suggested workflow

1. Create a focused branch from the current default branch.
2. Make the smallest change that solves the problem.
3. Preserve existing routes, API contracts, authentication behavior, and data formats unless the issue explicitly calls for a change.
4. Run relevant checks. For frontend changes, run `npm run build` from `front-end/`.
5. Test affected flows manually where automated tests are not available.
6. Review `git diff` and check for secrets, generated files, and unrelated changes.
7. Open a pull request with context, test results, and screenshots for visible UI changes.

## Commit and pull request guidance

- Use a clear, action-oriented commit message.
- Explain **what changed** and **why** in the pull request.
- Link related issues when applicable.
- Document any required environment-variable or deployment changes without including secret values.
- Call out tests that could not be run.

## Reporting bugs and proposing features

Use the repository's issue templates when available. Include reproducible steps, expected behavior, actual behavior, and relevant non-sensitive logs. Remove personal information and credentials from screenshots and logs.

## Code of conduct

Be respectful, constructive, and welcoming. Critique ideas and code rather than people. Harassment, discrimination, and deliberately exposing another person's private information are not acceptable.
