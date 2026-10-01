/**
 * ConnectWise Manage API Client
 *
 * Fetch-based HTTP client that handles authentication, pagination,
 * and self-signed certificate support for both cloud and self-hosted instances.
 *
 * Environment variables:
 *   CW_MANAGE_URL              - API base URL (e.g. https://api-na.myconnectwise.net)
 *   CW_MANAGE_COMPANY_ID       - Company identifier
 *   CW_MANAGE_PUBLIC_KEY        - API member public key
 *   CW_MANAGE_PRIVATE_KEY       - API member private key
 *   CW_MANAGE_CLIENT_ID         - Client ID from ConnectWise Developer Portal
 *   CW_MANAGE_REJECT_UNAUTHORIZED - Set to "false" to allow self-signed certs (default: "true")
 *
 * Self-signed certificate support is scoped to this client instance's own
 * requests via an undici Agent passed as the `dispatcher` option of the
 * standalone undici package's own `fetch` -- NOT via the process-global
 * NODE_TLS_REJECT_UNAUTHORIZED env var, which would affect every concurrent
 * request in the process (including unrelated tenants' cloud-hosted,
 * fully-verified connections).
 *
 * The Agent and the fetch that consumes it must come from the same package.
 * Node's global fetch runs the undici version bundled with the runtime, and it
 * rejects an Agent built by a different undici version with UND_ERR_INVALID_ARG,
 * which surfaces as a bare "fetch failed".
 */
import { Agent, fetch as undiciFetch } from "undici";

export interface CwManageConfig {
  baseUrl: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
}

export function getConfig(): CwManageConfig | null {
  const companyId = process.env.CW_MANAGE_COMPANY_ID;
  const publicKey = process.env.CW_MANAGE_PUBLIC_KEY;
  const privateKey = process.env.CW_MANAGE_PRIVATE_KEY;
  const clientId = process.env.CW_MANAGE_CLIENT_ID;

  if (!companyId || !publicKey || !privateKey || !clientId) {
    return null;
  }

  // Default to North America cloud. Override for EU, AU, or self-hosted.
  const baseUrl = (
    process.env.CW_MANAGE_URL || "https://api-na.myconnectwise.net"
  ).replace(/\/+$/, "");

  return { baseUrl, companyId, publicKey, privateKey, clientId };
}

/**
 * Low-level API client for ConnectWise Manage REST API.
 */
export class CwManageClient {
  private readonly authHeader: string;
  private readonly clientId: string;
  private readonly apiBase: string;
  private readonly dispatcher: Agent | undefined;

  constructor(config: CwManageConfig) {
    // Auth: Basic base64("{companyId}+{publicKey}:{privateKey}")
    const credentials = `${config.companyId}+${config.publicKey}:${config.privateKey}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;
    this.clientId = config.clientId;
    // Append the standard API path if the URL doesn't already contain it
    this.apiBase = config.baseUrl.includes("/v4_6_release/")
      ? config.baseUrl.replace(/\/+$/, "")
      : `${config.baseUrl}/v4_6_release/apis/3.0`;
    // Only build a custom dispatcher when relaxed TLS is explicitly requested.
    // Scoped to this client instance's own connections only -- never touches
    // process.env, so a self-hosted (self-signed) instance's relaxed TLS
    // verification can never bleed into a concurrent request against a
    // different (cloud, fully-verified) tenant's connection.
    //
    // The default (verified) path deliberately uses Node's built-in fetch with
    // no dispatcher. When a custom Agent exists, requests go through the
    // standalone `undici` package's own fetch instead (see request below),
    // because Node's global fetch rejects an Agent from a different undici
    // version than the one bundled in the running Node runtime.
    this.dispatcher =
      process.env.CW_MANAGE_REJECT_UNAUTHORIZED === "false"
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
  }

  private defaultHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      clientId: this.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * Make a request to the ConnectWise Manage API.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    },
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: this.defaultHeaders(),
    };

    if (options?.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    // Self-hosted instances with self-signed certificates: the dispatcher
    // built in the constructor (only when CW_MANAGE_REJECT_UNAUTHORIZED is
    // "false") scopes rejectUnauthorized to THIS client's connections only,
    // with no process-global state involved. It is paired with undici's own
    // fetch so the Agent and the fetch share one undici version. The verified
    // default path keeps Node's global fetch.
    const response = this.dispatcher
      ? await undiciFetch(url.toString(), {
          ...fetchOptions,
          dispatcher: this.dispatcher,
        } as Parameters<typeof undiciFetch>[1])
      : await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `ConnectWise API ${method} ${path} returned ${response.status}: ${errorBody}`,
      );
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  /** GET helper */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  /** POST helper */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** PATCH helper */
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  /** DELETE helper. Manage returns 204 No Content on success. */
  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
