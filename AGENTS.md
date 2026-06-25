# Repository Guidelines

## Project Structure & Module Organization

This repository is a VS Code extension written in TypeScript. The extension entrypoint is `src/extension.ts`. Shared extension logic lives under `src/core/`, including agent detection, configuration, reference building, template rendering, logging, and text utilities. Terminal discovery and insertion logic lives under `src/targets/`. Extension tests are in `src/test/extension.test.ts`. Static assets are in `resources/`, bundled output goes to `dist/`, and marketplace/package metadata is defined in `package.json`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run compile`: typecheck, lint, and bundle `dist/extension.js`.
- `npm run watch`: run TypeScript and esbuild watchers during extension development.
- `npm test`: compile tests, compile the extension, lint, then run VS Code extension tests.
- `npm run package:vsix`: build a local `.vsix` package with `vsce`.

Use **Run Extension** from VS Code to launch an Extension Development Host.

## Coding Style & Naming Conventions

Use TypeScript with ES2022 modules. Follow the existing tab-indented style in `src/**/*.ts`; keep imports named in camelCase or PascalCase. ESLint is configured in `eslint.config.mjs` and warns on import naming, missing semicolons, loose equality, missing curly braces, and thrown literals. Prefer small, focused functions and reuse existing helpers in `src/core/` before adding new abstractions.

## Testing Guidelines

Tests use Mocha through `@vscode/test-cli` and `@vscode/test-electron`. Add focused tests in `src/test/extension.test.ts` for user-visible command behavior, reference rendering, terminal target lifecycle, and configuration edge cases. Test names should describe behavior, for example `deduplicates selectable targets for the same terminal and agent`. Run `npm test` before submitting changes.

## Commit & Pull Request Guidelines

The current history only establishes a minimal `initial commit`, so use clear imperative commit subjects such as `Fix target picker dedupe` or `Update template settings docs`. Pull requests should explain the user-facing behavior change, list verification commands run, and include screenshots or short recordings for VS Code UI/menu changes. Link related issues when available.

## Security & Configuration Tips

Reference templates are evaluated as JavaScript template literals. Treat user-provided values in `atMentionBridge.templates` as trusted configuration only, document any new template variables, and avoid expanding template execution privileges. Do not commit generated `.vsix` files, or local VS Code test state.
