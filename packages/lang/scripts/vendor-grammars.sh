#!/bin/sh
# Copies prebuilt tree-sitter grammars (.wasm) into grammars/.
#
# Grammars are vendored instead of installed as dependencies: the npm packages also contain
# native bindings with install scripts, and Bowi never runs install scripts for users.
# Versions are pinned because grammar changes alter symbols and therefore Bowi's output (GRP-12).
# Run from packages/lang: sh scripts/vendor-grammars.sh
set -eu

# npm packages that ship their .wasm (schema helper grammars such as tree-sitter-yaml's
# core_schema are skipped).
NPM_GRAMMARS="tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 tree-sitter-json@0.24.8 @tree-sitter-grammars/tree-sitter-yaml@0.7.1"
# Grammars whose npm package has no .wasm: <github repo>@<tag>:<release asset>. The license
# comes from the same tag.
RELEASE_GRAMMARS="tree-sitter-grammars/tree-sitter-markdown@v0.5.3:tree-sitter-markdown.wasm"

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

: > "$here/grammars/VERSIONS"
for spec in $NPM_GRAMMARS; do
  (cd "$work" && npm pack --silent "$spec" > /dev/null)
  tarball=$(ls "$work"/*.tgz)
  mkdir "$work/pkg"
  tar xzf "$tarball" -C "$work/pkg"
  for wasm in "$work"/pkg/package/*.wasm; do
    case "$wasm" in
      *_schema.wasm) ;;
      *) cp "$wasm" "$here/grammars/" ;;
    esac
  done
  name=$(basename "${spec%@*}")
  cp "$work/pkg/package/LICENSE" "$here/grammars/LICENSE-$name"
  echo "$spec" >> "$here/grammars/VERSIONS"
  rm -rf "$work/pkg" "$tarball"
done
for spec in $RELEASE_GRAMMARS; do
  repo=${spec%@*}
  rest=${spec#*@}
  tag=${rest%%:*}
  asset=${rest#*:}
  name=$(basename "$repo")
  curl -fsSL -o "$here/grammars/$asset" "https://github.com/$repo/releases/download/$tag/$asset"
  curl -fsSL -o "$here/grammars/LICENSE-$name" "https://raw.githubusercontent.com/$repo/$tag/LICENSE"
  echo "$name@$tag (github.com/$repo release)" >> "$here/grammars/VERSIONS"
done
ls -l "$here/grammars"
