import { describe, expect, it } from "vitest";
import { resolvePostgresTarget } from "./postgres-connection.js";

describe("resolvePostgresTarget", () => {
  it("leaves a TCP URL unchanged", () => {
    const url = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
    expect(resolvePostgresTarget(url)).toEqual({ url });
  });

  it("maps an absolute host parameter to the socket path and removes it from the URL", () => {
    const target = resolvePostgresTarget("postgres://paperclip:paperclip@localhost:54329/paperclip?host=%2Frun%2Fdb&sslmode=disable");
    expect(target.path).toBe("/run/db/.s.PGSQL.54329");
    expect(target.url).toBe("postgres://paperclip:paperclip@localhost:54329/paperclip?sslmode=disable");
  });

  it("ignores a host parameter that is not a directory", () => {
    const url = "postgres://paperclip:paperclip@localhost:54329/paperclip?host=db.internal";
    expect(resolvePostgresTarget(url)).toEqual({ url });
  });

  it("leaves a value it cannot parse for the client to reject", () => {
    expect(resolvePostgresTarget("not a url")).toEqual({ url: "not a url" });
  });
});
