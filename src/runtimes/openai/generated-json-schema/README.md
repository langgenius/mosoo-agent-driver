# OpenAI app-server JSON schemas

These eight runtime schemas are selected from `@openai/codex@0.150.1` output and must not be edited by hand.

```sh
set -eu
vp exec codex --version
schema_tmp=$(mktemp -d)
trap 'rm -rf "$schema_tmp"' EXIT
schema_dir=src/runtimes/openai/generated-json-schema
vp exec codex app-server generate-json-schema --experimental --out "$schema_tmp"
fd --extension json . "$schema_dir" --exec rm
cp "$schema_tmp/ServerNotification.json" "$schema_dir/ServerNotification.json"
cp "$schema_tmp/ServerRequest.json" "$schema_dir/ServerRequest.json"
cp "$schema_tmp/v1/InitializeResponse.json" "$schema_dir/InitializeResponse.json"
cp "$schema_tmp/v2/ThreadBackgroundTerminalsCleanResponse.json" "$schema_dir/ThreadBackgroundTerminalsCleanResponse.json"
cp "$schema_tmp/v2/ThreadInjectItemsResponse.json" "$schema_dir/ThreadInjectItemsResponse.json"
cp "$schema_tmp/v2/ThreadStartResponse.json" "$schema_dir/ThreadStartResponse.json"
cp "$schema_tmp/v2/ThreadResumeResponse.json" "$schema_dir/ThreadResumeResponse.json"
cp "$schema_tmp/v2/TurnStartResponse.json" "$schema_dir/TurnStartResponse.json"
vp fmt "$schema_dir"
```
