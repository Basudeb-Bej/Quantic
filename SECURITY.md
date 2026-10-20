# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Quantic, report it privately through GitHub's private vulnerability reporting feature if it is enabled for this repository. Find it under the repository's **Security** section.

If private reporting is unavailable, contact the maintainer through a private channel listed on their GitHub profile. Do not post exploit instructions, secrets, personal data, or a working attack publicly.

## Please include

- A concise description of the potential issue
- The affected component or path
- Reproduction steps or a proof of concept that avoids accessing other people's data
- The potential impact
- Any suggested mitigation, if known

Please allow time for the report to be reviewed before publicly disclosing details.

## Protect credentials and data

- Never commit API keys, passwords, tokens, private keys, database connection strings, or populated environment files.
- Use deployment-provider secret settings for production configuration.
- If a secret is exposed, revoke or rotate it promptly; removing it from the latest commit alone may not remove it from Git history or other copies.
- Redact authentication cookies, authorization headers, personal information, and private logs before sharing diagnostics.
- Test only against systems and accounts you own or are explicitly authorized to assess.

## Scope

This policy covers security issues in the Quantic source code and its project configuration. It does not grant permission to test the live service or third-party infrastructure.
