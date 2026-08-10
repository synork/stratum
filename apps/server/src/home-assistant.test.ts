import { describe, expect, it } from "vitest";
import { HomeAssistantClient } from "./home-assistant.js";

describe("automation validation", () => {
  const client = new HomeAssistantClient("", "", "");

  it("requires triggers and actions", () => {
    expect(client.validateAutomation({ alias: "Empty" }).errors).toEqual([
      "Automation requires at least one trigger",
      "Automation requires at least one action",
    ]);
  });

  it("allows templates without treating them as entity IDs", () => {
    const result = client.validateAutomation({
      description: "Template test",
      triggers: [{ trigger: "template", value_template: "{{ is_state('light.kitchen', 'on') }}" }],
      actions: [{ action: "logbook.log", data: { message: "ok" } }],
    });
    expect(result.valid).toBe(true);
  });

  it("blocks explicit unknown entity targets", () => {
    const result = client.validateAutomation({
      triggers: [{ trigger: "state", entity_id: "binary_sensor.missing" }],
      actions: [{ action: "light.turn_off", target: { entity_id: "light.missing" } }],
    });
    expect(result.errors).toEqual(["Unknown entity: binary_sensor.missing", "Unknown entity: light.missing"]);
  });

  it("requires dashboard views", () => {
    expect(client.validateDashboard({}).errors).toContain("Dashboard requires at least one view");
  });

  it("accepts a dashboard without entity-bound cards", () => {
    expect(client.validateDashboard({ views: [{ title: "Home", cards: [{ type: "markdown", content: "Hello" }] }] }).valid).toBe(true);
  });

  it("validates input number helper bounds", () => {
    expect(client.validateHelper("input_number", { name: "Target", min: 30, max: 10 }).errors).toContain("Input number max must be greater than min");
    expect(client.validateHelper("input_number", { name: "Target", min: 10, max: 30, initial: 20 }).valid).toBe(true);
  });

  it("validates input select helper options", () => {
    expect(client.validateHelper("input_select", { name: "Mode", options: ["Home", "Home"] }).errors).toContain("Input select options must be unique");
    expect(client.validateHelper("input_select", { name: "Mode", options: ["Home", "Away"], initial: "Away" }).valid).toBe(true);
  });

  it("requires a date or time for input datetime helpers", () => {
    expect(client.validateHelper("input_datetime", { name: "When" }).valid).toBe(false);
    expect(client.validateHelper("input_datetime", { name: "When", has_time: true }).valid).toBe(true);
  });
});
