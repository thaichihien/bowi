#!/bin/sh
# Copies prebuilt tree-sitter grammars (.wasm) from their npm packages into grammars/.
#
# Grammars are vendored instead of installed as dependencies: the npm packages also contain
# native bindings with install scripts, and Bowi never runs install scripts for users.
# Versions are pinned because grammar changes alter symbols and therefore Bowi's output (GRP-12).
# Run from packages/lang: sh scripts/vendor-grammars.sh
set -eu

GRAMMARS="tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 tree-sitter-json@0.24.8"

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

: > "$here/grammars/VERSIONS"
for spec in $GRAMMARS; do
  (cd "$work" && npm pack --silent "$spec" > /dev/null)
  tarball=$(ls "$work"/*.tgz)
  mkdir "$work/pkg"
  tar xzf "$tarball" -C "$work/pkg"
  cp "$work"/pkg/package/*.wasm "$here/grammars/"
  name=${spec%@*}
  cp "$work/pkg/package/LICENSE" "$here/grammars/LICENSE-$name"
  echo "$spec" >> "$here/grammars/VERSIONS"
  rm -rf "$work/pkg" "$tarball"
done
ls -l "$here/grammars"
