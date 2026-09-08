import { describe, it, expect } from "vitest";

import { normaliseOrigin, normalisePath, CutoverUrlError } from "./urls";

describe("normaliseOrigin", () => {
  it("accepts a bare origin and drops a lone trailing slash", () => {
    expect(normaliseOrigin("https://a.example", "--url")).toBe("https://a.example");
    expect(normaliseOrigin("https://a.example/", "--url")).toBe("https://a.example");
  });

  it("refuses a url that already carries the webhook path", () => {
    // The bug this exists for: --url https://rails/webhook with
    // --webhook-path /webhook built https://rails/webhook/webhook. Fluid
    // stores it, the read-back matches it, and every delivery 404s — and the
    // Rails destination is not probed, so nothing else catches it.
    expect(() => normaliseOrigin("https://rails.example/webhook", "--url")).toThrow(
      CutoverUrlError,
    );
    expect(() => normaliseOrigin("https://rails.example/webhook", "--url")).toThrow(
      /bare origin with no path/,
    );
  });

  it("refuses a query or fragment", () => {
    expect(() => normaliseOrigin("https://a.example/?x=1", "--url")).toThrow(
      /query or fragment/,
    );
    expect(() => normaliseOrigin("https://a.example/#x", "--url")).toThrow(
      /query or fragment/,
    );
  });

  it("refuses a non-http scheme and a non-url", () => {
    expect(() => normaliseOrigin("ftp://a.example", "--url")).toThrow(/http\(s\)/);
    expect(() => normaliseOrigin("not a url", "--url")).toThrow(/absolute https url/);
  });
});

describe("normalisePath", () => {
  it("accepts an absolute single-slash path", () => {
    expect(normalisePath("/api/webhooks", "--webhook-path")).toBe("/api/webhooks");
  });

  it("refuses a value that would choose the host", () => {
    // `${origin}@evil.example/x` has host evil.example.
    expect(() => normalisePath("@evil.example/x", "--webhook-path")).toThrow(
      CutoverUrlError,
    );
    expect(() => normalisePath("//evil.example/x", "--webhook-path")).toThrow(
      CutoverUrlError,
    );
  });
});
