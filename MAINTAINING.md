# Maintaining

Notes for the maintainer — not needed to just *use* the tool (see [README.md](README.md)).

## Local development

```bash
node cli.js              # run directly
npm link                 # expose `claude-memory-editor` / `cme` globally for testing
node --check cli.js      # syntax check
```

The whole app is a single zero-dependency file, `cli.js` (server + embedded
single-page UI). No build step.

## Releasing

Users can already run it without npm via `npx github:PascalTemel/claude-memory-editor`,
so publishing to npm is optional.

To publish to the npm registry:

```bash
npm version patch          # bump version + tag
git push --follow-tags
npm publish --access public
```

Then anyone can run `npx claude-memory-editor`.

If the bare name `claude-memory-editor` is taken on npm, scope it (e.g.
`@pascaltemel/claude-memory-editor`) by changing `name` in `package.json`.
