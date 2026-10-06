# Readar CLI development

This is an independent TypeScript / Node.js repository. Communicate with Readar only through HTTP; never import backend source or connect to its database.

- Require Node.js 22+; publish compiled JavaScript through the `readar` executable.
- Preserve JSON stdout, JSON stderr errors, and documented exit codes.
- Never print tokens or read credential files into agent context.
- Preserve server-side user isolation and session refresh rotation. Test concurrent processes when changing session handling.
- Build and run `npm run check` and `npm test` before claiming completion. Integration tests listen only on ephemeral loopback ports and use temporary credentials/configuration.
- Keep generated `dist/`, `node_modules/`, session files and `.env` out of Git.
- Registry publication and remote repository creation are separate actions; do not claim publication from a successful local package test.
