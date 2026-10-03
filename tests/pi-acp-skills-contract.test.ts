import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildPiBootstrapFiles } from "../src/runtimes/acp/pi-acp-bootstrap";
import { createBootstrapFixture } from "./fixtures/pi-acp/bootstrap";
import type { AcpProcess } from "./fixtures/pi-acp/contract";

const contractTest = process.env["PI_ACP_PINNED_CONTRACT"] === "1" ? test : test.skip;

async function initialize(client: AcpProcess): Promise<void> {
  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "skills-contract", version: "1" },
  });
}

contractTest(
  "Given restored ambient skills and a previously selected Host Skill, When cold loading with empty then refreshed selections, Then only current explicit skills are advertised and native conversation survives",
  async () => {
    const fixture = await createBootstrapFixture();
    try {
      await fixture.materialize("FIRST");
      for (const [path, name] of [
        [join(fixture.agentDir, "skills/restored/SKILL.md"), "restored-native"],
        [join(fixture.home, ".agents/skills/restored/SKILL.md"), "restored-agents"],
        [join(fixture.cwd, ".agents/skills/restored/SKILL.md"), "restored-project"],
      ]) {
        await mkdir(dirname(path!), { recursive: true });
        await writeFile(
          path!,
          `---\nname: ${name}\ndescription: UNSELECTED_${name}\n---\nRestored skill body\n`,
        );
      }
      let client = fixture.start();
      await initialize(client);
      const first = await client.request("session/new", { cwd: fixture.cwd, mcpServers: [] });
      fixture.steps.push({ text: "SELECTED_FIRST_DONE" });
      expect((await client.prompt(first.sessionId, "Perform the first task")).stopReason).toBe(
        "end_turn",
      );
      const firstSystem = JSON.stringify(
        fixture.requests.at(-1)?.messages.filter((message) => message.role === "system"),
      );
      expect(firstSystem).toContain("PI_EXPLICIT_SKILL_DESCRIPTION_FIRST");
      // Assert after cold removal too, so the original regression reproduces the
      // continuation failure even if initial selection also sees ambient skills.
      await client.stop();
      const mapPath = join(fixture.home, ".pi/pi-acp/session-map.json");
      const sessionMap = await readFile(mapPath, "utf8");
      const files = buildPiBootstrapFiles(fixture.payload, []);
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(fixture.agentDir, name), contents);
      }
      expect(await readFile(mapPath, "utf8")).toBe(sessionMap);
      client = fixture.start();
      await initialize(client);
      await client.request("session/load", {
        sessionId: first.sessionId,
        cwd: fixture.cwd,
        mcpServers: [],
      });
      fixture.steps.push({ text: "EMPTY_SELECTION_DONE" });
      expect(
        (await client.prompt(first.sessionId, "Continue with empty selection")).stopReason,
      ).toBe("end_turn");
      const coldMessages = fixture.requests.at(-1)?.messages;
      const coldSystem = JSON.stringify(
        coldMessages?.filter((message) => message.role === "system"),
      );
      expect(coldSystem).not.toContain("UNSELECTED_");
      expect(coldSystem).not.toContain("PI_EXPLICIT_SKILL_DESCRIPTION_FIRST");
      expect(JSON.stringify(coldMessages)).toContain("SELECTED_FIRST_DONE");
      expect(firstSystem).not.toContain("UNSELECTED_");
      await client.stop();
      await fixture.materialize("COLD");
      client = fixture.start();
      await initialize(client);
      await client.request("session/load", {
        sessionId: first.sessionId,
        cwd: fixture.cwd,
        mcpServers: [],
      });
      fixture.steps.push({ text: "REFRESHED_SELECTION_DONE" });
      expect(
        (await client.prompt(first.sessionId, "Continue with refreshed selection")).stopReason,
      ).toBe("end_turn");
      const refreshedSystem = JSON.stringify(
        fixture.requests.at(-1)?.messages.filter((message) => message.role === "system"),
      );
      expect(refreshedSystem).toContain("PI_EXPLICIT_SKILL_DESCRIPTION_COLD");
      expect(refreshedSystem).not.toContain("PI_EXPLICIT_SKILL_DESCRIPTION_FIRST");
      expect(refreshedSystem).not.toContain("UNSELECTED_");
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.errors).toEqual([]);
      expect(fixture.steps).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  60_000,
);
