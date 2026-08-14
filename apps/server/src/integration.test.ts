import { describe, expect, it } from "vitest";
import { validateIntegration, IntegrationInstaller } from "./integration.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const goodManifest = (domain: string) =>
  JSON.stringify({ domain, name: "Test", version: "1.0.0", codeowners: ["@test"] });

const goodInit = (domain: string) =>
  `"""${domain} integration."""
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry."""
    return True
`;

const goodSensor = () =>
  `"""Sensor platform."""
from homeassistant.helpers.entity import Entity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    async_add_entities([DemoSensor()])


class DemoSensor(Entity):
    @property
    def name(self):
        return "Demo"

    @property
    def state(self):
        return "on"
`;

describe("validateIntegration", () => {
  it("accepts a minimal valid integration", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": goodInit("washer_monitor"),
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects bad domain names", () => {
    const result = validateIntegration({
      domain: "my bad domain",
      files: {
        "manifest.json": goodManifest("my_bad_domain"),
        "__init__.py": goodInit("bad"),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("domain"))).toBe(true);
  });

  it("rejects unsafe file paths", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": goodInit("washer_monitor"),
        "../outside.txt": "x",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid file path"))).toBe(true);
  });

  it("rejects imports outside the allowlist", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": goodInit("washer_monitor"),
        "sensor.py": "import flask\n" + goodSensor(),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("flask"))).toBe(true);
  });

  it("rejects blocked operations", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": "import subprocess\nsubprocess.call(['rm','-rf','/'])\n",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("blocked"))).toBe(true);
  });

  it("rejects missing manifest / init", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: { "sensor.py": goodSensor() },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.json"))).toBe(true);
    expect(result.errors.some((e) => e.includes("__init__.py"))).toBe(true);
  });

  it("rejects large files (>40KB)", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": goodInit("washer_monitor"),
        "sensor.py": "x".repeat(50_000),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds"))).toBe(true);
  });

  it("reports a warning when config_flow.py is missing", () => {
    const result = validateIntegration({
      domain: "washer_monitor",
      files: {
        "manifest.json": goodManifest("washer_monitor"),
        "__init__.py": goodInit("washer_monitor"),
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("config_flow"))).toBe(true);
  });
});

describe("IntegrationInstaller", () => {
  it("writes, snapshots, lists and removes an integration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "int-test-"));
    try {
      const installer = new IntegrationInstaller(dir);
      const files = {
        "manifest.json": goodManifest("demo"),
        "__init__.py": goodInit("demo"),
        "sensor.py": goodSensor(),
      };
      await installer.write("demo", files);
      expect(await installer.exists("demo")).toBe(true);
      expect(await installer.listInstalled()).toEqual(["demo"]);

      const snapshot = await installer.snapshot("demo");
      expect(snapshot).not.toBeNull();
      expect(snapshot?.["manifest.json"]).toContain("demo");

      // rollback from a snapshot restores files
      await installer.rollback("demo", snapshot);
      expect(await installer.exists("demo")).toBe(true);
      const restored = await installer.snapshot("demo");
      expect(restored?.["manifest.json"]).toContain("demo");

      await installer.remove("demo");
      expect(await installer.exists("demo")).toBe(false);
      expect(await installer.listInstalled()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write paths outside the domain directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "int-path-"));
    try {
      const installer = new IntegrationInstaller(dir);
      await expect(
        installer.write("demo", { "../escape.txt": "x" }),
      ).rejects.toThrow(/unsafe/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});