import { describe, expect, test } from "bun:test";

import images from "../runtime-images.json";
import { SUPPORTED_DRIVER_RUNTIMES } from "../src/protocol/runtime";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";

describe("runtime image coverage", () => {
  test("gives every admitted runtime and executable backend an image tested by CI", () => {
    const runtimeIds = images.map((image) => image.runtimeId).toSorted();
    expect(runtimeIds).toEqual([...SUPPORTED_DRIVER_RUNTIMES].toSorted());
    expect(runtimeIds).toEqual(
      AGENT_DRIVER_PROVIDER_REGISTRY.list()
        .map((provider) => provider.runtime)
        .toSorted(),
    );
    expect(new Set(images.map((image) => image.profile)).size).toBe(images.length);
    expect(images.some((image) => image.profile === "all")).toBe(false);
  });
});
