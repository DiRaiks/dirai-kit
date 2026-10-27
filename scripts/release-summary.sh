#!/usr/bin/env bash
# Writes what the release run published to the job summary: one section per package
# tagged on this commit, with its links and release notes. Needs GH_TOKEN for gh.
set -euo pipefail

summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
repo=${GITHUB_REPOSITORY:-DiRaiks/dirai-kit}
# Package tags look like @dirai-kit/tg@1.6.0; old v1.x tags belong to @dirai/tg-kit
tags=$(git tag --points-at HEAD --list '@dirai-kit/*@*' | sort)

if [ -z "$tags" ]; then
  {
    echo '## Nothing released'
    echo
    echo 'No package has a `feat`, `fix`, `perf` or breaking commit since its last release.'
  } >>"$summary"
  exit 0
fi

{
  echo '## Released'
  echo
  echo '| Package | Version | npm | GitHub |'
  echo '| --- | --- | --- | --- |'
  for tag in $tags; do
    name=${tag%@*}
    version=${tag##*@}
    echo "| \`$name\` | $version | [npm](https://www.npmjs.com/package/$name/v/$version) | [release](https://github.com/$repo/releases/tag/$tag) |"
  done
  for tag in $tags; do
    echo
    echo "### $tag"
    echo
    # The release notes semantic-release wrote to the GitHub Release
    gh release view "$tag" --repo "$repo" --json body --jq .body 2>/dev/null ||
      echo '_No GitHub Release found for this tag._'
  done
} >>"$summary"
