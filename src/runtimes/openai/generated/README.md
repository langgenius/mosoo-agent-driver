# OpenAI app-server protocol types

This directory contains the transitive closure of the OpenAI app-server types imported by the driver.

They correspond to OpenAI app-server runtime version `0.150.1`, which is also pinned by the CLI dependency and container image.

Runtime validation and the complete supported server method sets come from the adjacent JSON Schemas.

Regenerate those schemas first, then regenerate and prune the TypeScript output with the matching runtime:

```sh
set -eu
generated_dir=src/runtimes/openai/generated
generated_tmp=$(mktemp -d)
trap 'rm -rf "$generated_tmp"' EXIT
vp exec codex app-server generate-ts --experimental --out "$generated_tmp"
fd --extension ts . "$generated_dir" --exec rm
cp -R "$generated_tmp"/. "$generated_dir"/
bun scripts/prune-openai-generated-types.mjs
vp fmt "$generated_dir" --write
```

The pruning script follows every direct generated-type import from `app-server-protocol-types.ts`, so upstream fields and their complete dependency closure are retained automatically.

Do not edit individual generated TypeScript files by hand.
