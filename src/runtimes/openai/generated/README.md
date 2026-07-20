# OpenAI app-server protocol

The TypeScript files in this directory are generated as one atomic schema set.

They correspond to OpenAI app-server runtime version `0.144.5`, which is also pinned by the SDK dependency and container image.

Regenerate them with the matching runtime:

```sh
codex app-server generate-ts --out src/runtimes/openai/generated
```

Do not split or edit individual generated TypeScript files by hand.
