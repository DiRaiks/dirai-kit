export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's commit bodies carry long lines of release notes
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
