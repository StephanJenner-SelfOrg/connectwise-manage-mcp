import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "undici";
import { CwManageClient, type CwManageConfig } from "../api-client.js";

// The relaxed path calls undici's own fetch so the Agent and the fetch share one
// undici version. Replace only `fetch`; Agent stays real so instanceof checks hold.
const undiciFetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciFetchMock,
}));

const baseConfig: CwManageConfig = {
  baseUrl: "https://api-na.myconnectwise.net",
  companyId: "acme",
  publicKey: "pub",
  privateKey: "priv",
  clientId: "client-1",
};

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("CwManageClient TLS dispatcher (no process.env mutation)", () => {
  const savedRejectEnv = process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
  const savedTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  afterEach(() => {
    if (savedRejectEnv === undefined) delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    else process.env.CW_MANAGE_REJECT_UNAUTHORIZED = savedRejectEnv;
    if (savedTlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsEnv;
    vi.unstubAllGlobals();
    undiciFetchMock.mockReset();
  });

  it("never reads or writes process.env.NODE_TLS_REJECT_UNAUTHORIZED", async () => {
    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    undiciFetchMock.mockResolvedValue(fakeResponse({ ok: true }));

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("uses Node's default fetch dispatcher when TLS verification is not relaxed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(options).not.toHaveProperty("dispatcher");
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it("passes a per-instance undici Agent to undici's own fetch when relaxed, not a global toggle", async () => {
    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    const globalFetchMock = vi.fn();
    vi.stubGlobal("fetch", globalFetchMock);
    undiciFetchMock.mockResolvedValue(fakeResponse({ ok: true }));

    const client = new CwManageClient(baseConfig);
    await client.get("/system/info");

    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [, options] = undiciFetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(options.dispatcher).toBeInstanceOf(Agent);
    // Node's global fetch rejects a foreign Agent, so it must not see this request.
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("only the relaxed client instance carries a custom dispatcher", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    undiciFetchMock.mockResolvedValue(fakeResponse({ ok: true }));

    process.env.CW_MANAGE_REJECT_UNAUTHORIZED = "false";
    const selfHostedClient = new CwManageClient({ ...baseConfig, clientId: "self-hosted" });

    delete process.env.CW_MANAGE_REJECT_UNAUTHORIZED;
    const cloudClient = new CwManageClient({ ...baseConfig, clientId: "cloud" });

    await Promise.all([
      selfHostedClient.get("/system/info"),
      cloudClient.get("/system/info"),
    ]);

    // Only the self-hosted client's request goes through undici's fetch with the
    // relaxed Agent; the cloud client uses Node's global fetch with no
    // dispatcher -- no shared/global toggle.
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [, relaxedOptions] = undiciFetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(relaxedOptions.dispatcher).toBeInstanceOf(Agent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, cloudOptions] = fetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
    expect(cloudOptions.dispatcher).toBeUndefined();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
