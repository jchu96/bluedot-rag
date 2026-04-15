import { describe, it, expect } from "vitest";
import { isAllowed } from "./allowlist";

describe("isAllowed", () => {
  it("matches a single username exactly", () => {
    expect(isAllowed("jchu96", "jchu96")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAllowed("JChu96", "jchu96")).toBe(true);
    expect(isAllowed("jchu96", "JCHU96")).toBe(true);
  });

  it("parses comma-separated lists", () => {
    expect(isAllowed("bob", "alice,bob,carol")).toBe(true);
    expect(isAllowed("alice", "alice,bob,carol")).toBe(true);
    expect(isAllowed("carol", "alice,bob,carol")).toBe(true);
  });

  it("normalizes whitespace around entries", () => {
    expect(isAllowed("bob", "  alice , bob , carol  ")).toBe(true);
    expect(isAllowed("bob", "\talice,\n bob ,carol\n")).toBe(true);
  });

  it("rejects unknown usernames", () => {
    expect(isAllowed("mallory", "alice,bob")).toBe(false);
  });

  it("rejects empty username", () => {
    expect(isAllowed("", "alice,bob")).toBe(false);
  });

  it("rejects when allowedCsv is empty", () => {
    expect(isAllowed("alice", "")).toBe(false);
    expect(isAllowed("alice", "   ")).toBe(false);
  });

  it("rejects when allowedCsv is undefined", () => {
    expect(isAllowed("alice", undefined)).toBe(false);
  });

  it("treats empty entries in csv as no-match (no accidental allow-all)", () => {
    expect(isAllowed("", ",,,")).toBe(false);
    expect(isAllowed("anything", ",,,")).toBe(false);
  });
});
