import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverSkillCatalogEntry } from "../src/protocol/boot";
import { writeSkillBootstrapArtifacts } from "../src/runtimes/skill-bootstrap";
import { driverStartInput } from "./driver-boot-payload-fixture";

test("clears persisted skill catalog entries when a restored session selects no skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
  const skill = {
    frontmatter: { author: null, description: "Review code changes.", version: null },
    mountPath: join(root, ".mosoo", "skill", "review"),
    resolutionMode: "explicit",
    skillId: "skill-1" as DriverSkillCatalogEntry["skillId"],
    skillName: "review",
  } satisfies DriverSkillCatalogEntry;
  const execution = {
    ...driverStartInput.execution,
    session: { ...driverStartInput.execution.session, sharedRootPath: root },
    skillCatalog: [skill],
  };

  try {
    const artifacts = await writeSkillBootstrapArtifacts(execution);
    expect(JSON.parse(await readFile(artifacts.manifestPath, "utf8"))).toEqual([
      { ...skill, skillMarkdownPath: join(skill.mountPath, "SKILL.md") },
    ]);
    expect(await readFile(artifacts.readmePath, "utf8")).toContain(skill.mountPath);

    await writeSkillBootstrapArtifacts({ ...execution, skillCatalog: [] });

    expect(JSON.parse(await readFile(artifacts.manifestPath, "utf8"))).toEqual([]);
    const readme = await readFile(artifacts.readmePath, "utf8");
    expect(readme).toContain("No skills are available for this session.");
    expect(readme).not.toContain(skill.skillName);
    expect(readme).not.toContain(skill.mountPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
