import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const archive = 'director-calendar-v1.0.0-rc.9-generic.zip';
const temp = '.bootstrap-src';

rmSync(temp, { recursive: true, force: true });
mkdirSync(temp);
execFileSync('unzip', ['-q', archive, '-d', temp], { stdio: 'inherit' });

for (const dir of ['src', 'tests', 'docs', 'fixtures', 'demo']) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(`${temp}/${dir}`, dir, { recursive: true });
}

for (const file of ['README.md', 'package.json', 'tsconfig.json']) {
  cpSync(`${temp}/${file}`, file);
}
rmSync(temp, { recursive: true, force: true });
rmSync(archive, { force: true });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.packageManager = 'npm@12.2.2';
pkg.repository = { type: 'git', url: 'git+https://github.com/oneshubhamt/calendar.git' };
pkg.bugs = { url: 'https://github.com/oneshubhamt/calendar/issues' };
pkg.homepage = 'https://github.com/oneshubhamt/calendar#readme';
pkg.devDependencies = { ...pkg.devDependencies, typescript: '7.0.2' };
pkg.scripts = {
  ...pkg.scripts,
  check: 'npm run typecheck && npm test && npm pack --dry-run',
  prepack: 'npm run build'
};
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

let readme = readFileSync('README.md', 'utf8');
readme = readme.replace(
  /## Quality\n\n```bash\nnpm run typecheck\nnpm test\n```/,
  `## Development

Use the repository-pinned toolchain:

\`\`\`bash
nvm use
npm ci
npm run check
\`\`\`

The normal quality gate is strict TypeScript typechecking, the complete non-visual test suite, and package-content validation. Screenshot/browser-gallery QA is intentionally separate from routine QA.`
);
writeFileSync('README.md', readme);

writeFileSync('.nvmrc', '26.13.0\n');
writeFileSync('.npmrc', 'save-exact=true\n');
writeFileSync('.gitignore', `node_modules/
dist/
*.tgz
*.log
coverage/
ci-artifacts/
.DS_Store
`);
writeFileSync('.editorconfig', `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true

[*.{ts,js,mjs,json,yml,yaml}]
indent_style = space
indent_size = 2
`);
writeFileSync('CONTRIBUTING.md', `# Contributing

Use the repository-pinned Node.js and npm versions before changing the calendar:

\`\`\`sh
nvm use
npm ci
npm run check
\`\`\`

\`npm run check\` is the normal quality gate: strict TypeScript typechecking, the complete non-visual test suite, and package-content validation. Screenshot/browser-gallery testing is intentionally not part of routine QA.

Keep the core calendar domain-generic. Application-specific semantics belong behind adapters, integrations, or optional feature modules.
`);

mkdirSync('.github/workflows', { recursive: true });
writeFileSync('.github/workflows/ci.yml', `name: CI

on:
  push:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Typecheck, test and package
    runs-on: ubuntu-24.04
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v7.0.1

      - name: Set up Node.js
        uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .nvmrc
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Use pinned npm
        run: npm install --global npm@12.2.2

      - name: Verify toolchain
        run: |
          test "$(node --version)" = "v26.13.0"
          test "$(npm --version)" = "12.2.2"
          test "$(npx tsc --version)" = "Version 7.0.2"

      - name: Install dependencies
        run: npm ci

      - name: Quality gate
        run: npm run check
`);

writeFileSync('.github/dependabot.yml', `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      development-toolchain:
        patterns:
          - typescript

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
`);

rmSync('.github/workflows/bootstrap.yml', { force: true });
rmSync('.github/bootstrap.mjs', { force: true });
