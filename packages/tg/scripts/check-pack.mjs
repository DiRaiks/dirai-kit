// Fails when the npm tarball would contain anything besides the build output and docs
import { execFileSync } from 'node:child_process';

const allowed = [
  /^dist\//,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
  /^package\.json$/,
];

const [{ files }] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }),
);
const unexpected = files
  .map((file) => file.path)
  .filter((path) => !allowed.some((re) => re.test(path)));

if (unexpected.length > 0) {
  console.error(`Unexpected files in the package:\n${unexpected.join('\n')}`);
  process.exit(1);
}
if (!files.some((file) => file.path === 'dist/index.js')) {
  console.error('dist/index.js is missing, run the build first');
  process.exit(1);
}
console.log(`Package contents OK (${files.length} files)`);
