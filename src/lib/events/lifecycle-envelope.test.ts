import { describe, it, expect } from "vitest";

import { unwrapLifecycleEnvelope } from "./lifecycle-envelope";

describe("unwrapLifecycleEnvelope", () => {
  it("returns the nested payload of a lifecycle envelope", () => {
    const payload = { company: { droplet_installation_uuid: "dri_1" }, resource: "droplet" };
    expect(unwrapLifecycleEnvelope({ id: 1, name: "droplet_installed", payload })).toBe(payload);
  });

  it("leaves a body with a top-level company untouched, even if it also has a payload", () => {
    const body = { company: { id: 1 }, payload: { company: { id: 2 } } };
    expect(unwrapLifecycleEnvelope(body)).toBe(body);
  });

  it("leaves bodies without a nested company object untouched", () => {
    for (const body of [
      { resource: "order", event: "created", order: { id: 1 } },
      { payload: { order: { id: 1 } } },
      { payload: { company: "not-an-object" } },
      { payload: { company: [] } },
      { payload: [] },
    ]) {
      expect(unwrapLifecycleEnvelope(body)).toBe(body);
    }
  });

  it("passes non-objects through", () => {
    expect(unwrapLifecycleEnvelope(null)).toBeNull();
    expect(unwrapLifecycleEnvelope("x")).toBe("x");
    const arr: unknown[] = [];
    expect(unwrapLifecycleEnvelope(arr)).toBe(arr);
  });
});
