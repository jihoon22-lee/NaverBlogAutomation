import { describe, expect, it } from "vitest";

import { resolveApiCommand } from "./api-command.js";

describe("resolveApiCommand", () => {
  it("uses the frozen uv application by default", () => {
    expect(resolveApiCommand({})).toEqual({
      executable: "uv",
      args: ["run", "--frozen", "naver-blog-api"],
    });
  });

  it("spawns an absolute installed console script directly", () => {
    expect(
      resolveApiCommand({ SYSTEM_E2E_API_EXECUTABLE: "/tmp/e2e-venv/bin/naver-blog-api" }),
    ).toEqual({ executable: "/tmp/e2e-venv/bin/naver-blog-api", args: [] });
  });

  it.each(["", "   "])("rejects an empty executable override", (executable) => {
    expect(() => resolveApiCommand({ SYSTEM_E2E_API_EXECUTABLE: executable })).toThrow(
      "must not be empty",
    );
  });

  it("rejects a relative executable override", () => {
    expect(() =>
      resolveApiCommand({ SYSTEM_E2E_API_EXECUTABLE: "e2e-venv/bin/naver-blog-api" }),
    ).toThrow("must be an absolute path");
  });
});
