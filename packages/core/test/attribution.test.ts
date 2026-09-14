import { afterEach, describe, expect, it } from "vitest";
import { attributionHeaders, DEFAULT_APP_TITLE, DEFAULT_APP_URL } from "../src/index.js";

describe("openrouter attribution", () => {
  afterEach(() => {
    delete process.env.SWITCHYARD_APP_TITLE;
    delete process.env.SWITCHYARD_APP_URL;
  });

  it("sends both ranking headers by default", () => {
    const headers = attributionHeaders();
    expect(headers["X-Title"]).toBe(DEFAULT_APP_TITLE);
    expect(headers["HTTP-Referer"]).toBe(DEFAULT_APP_URL);
  });

  it("can be overridden by env or arguments", () => {
    process.env.SWITCHYARD_APP_TITLE = "My Router";
    expect(attributionHeaders()["X-Title"]).toBe("My Router");
    expect(attributionHeaders({ title: "Explicit" })["X-Title"]).toBe("Explicit");
  });

  it("never sends an empty header", () => {
    const headers = attributionHeaders({ title: "", referer: "" });
    expect(headers["X-Title"]).toBe(DEFAULT_APP_TITLE);
    expect(headers["HTTP-Referer"]).toBe(DEFAULT_APP_URL);
  });
});
