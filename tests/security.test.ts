import { describe, expect, it } from "vitest";
import { REDACTED, redactValue } from "../src/security/redaction";

describe("secret redaction", () => {
  it("redacts sensitive keys recursively", () => {
    const safe = redactValue({ password: "p4ss", nested: { api_key: "abc", regular: "visible" } });
    expect(safe).toEqual({ password: REDACTED, nested: { api_key: REDACTED, regular: "visible" } });
  });

  it("redacts URI credentials, JAAS values, and secret environment references", () => {
    const input = "mongodb://user:pass@host/db password=\"secret\" token=${SERVICE_TOKEN}";
    const output = String(redactValue(input));
    expect(output).not.toContain("user:pass");
    expect(output).not.toContain("secret\"");
    expect(output).not.toContain("SERVICE_TOKEN");
  });
});
