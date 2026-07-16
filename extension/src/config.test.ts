import { describe, expect, it } from "vitest";

import { LOCAL_API_ORIGIN } from "./config";

describe("extension configuration", () => {
  it("uses the loopback API origin from the architecture contract", () => {
    expect(LOCAL_API_ORIGIN).toBe("http://127.0.0.1:8765");
  });
});
