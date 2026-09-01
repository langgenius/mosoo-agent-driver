# OpenAI app-server protocol types

This directory contains the transitive closure of the OpenAI app-server types imported by the driver.

They correspond to OpenAI app-server runtime version `0.152.0`, which is also pinned by the CLI dependency and container image.

Runtime validation and the complete supported server method sets come from the adjacent JSON Schemas.

Regenerate the selected schemas and reachable TypeScript files with the matching runtime:

```sh
bun scripts/sync-openai-generated.mjs
```

The synchronization script follows every direct generated-type import from `app-server-protocol-types.ts`, so upstream fields and their complete dependency closure are retained automatically.

Do not edit individual generated TypeScript files by hand.
