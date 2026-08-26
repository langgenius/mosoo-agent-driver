# OpenAI app-server protocol

The TypeScript files in this directory are generated as one atomic schema set.

They correspond to OpenAI app-server runtime version `0.150.1`, which is also pinned by the CLI dependency and container image.

Runtime validation lives in the adjacent `app-server-protocol-*` modules and is typed against this schema.

Regenerate them with the matching runtime:

```sh
generated_dir=src/runtimes/openai/generated
generated_tmp=$(mktemp -d)
trap 'rm -rf "$generated_tmp"' EXIT
vp exec codex app-server generate-ts --experimental --out "$generated_tmp"
fd --extension ts . "$generated_dir" --exec rm
cp -R "$generated_tmp"/. "$generated_dir"/
vp fmt "$generated_dir" --write
```

Do not split or edit individual generated TypeScript files by hand.
