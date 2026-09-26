/**
 * Tests for the agreement addition tools.
 *
 * Every test drives the registered tool handlers against a stub client, so no
 * request ever reaches ConnectWise. cw_update_agreement_addition_product in
 * particular is only ever exercised against mocked responses: a real PATCH to
 * an agreement addition changes live billing on a customer's next invoice.
 */

import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CwManageClient } from "../api-client.js";
import { registerAgreementTools } from "../tools/agreements.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * A GET responder. `nth` is how many GETs have already hit this exact path,
 * which is what lets a test return a different addition before and after the
 * PATCH.
 */
type GetResponder = (
  path: string,
  params: Record<string, string | number | undefined>,
  nth: number,
) => unknown;

class StubClient {
  calls: RecordedCall[] = [];
  getResponder: GetResponder = () => [];
  patchResponse: unknown = {};

  async get(path: string, params: Record<string, string | number | undefined> = {}) {
    const nth = this.calls.filter(
      (call) => call.method === "GET" && call.path === path,
    ).length;
    this.calls.push({ method: "GET", path, params });
    return this.getResponder(path, params, nth);
  }

  async post(path: string, body: unknown) {
    this.calls.push({ method: "POST", path, body });
    return {};
  }

  async patch(path: string, body: unknown) {
    this.calls.push({ method: "PATCH", path, body });
    return this.patchResponse;
  }

  gets(): RecordedCall[] {
    return this.calls.filter((call) => call.method === "GET");
  }

  patches(): RecordedCall[] {
    return this.calls.filter((call) => call.method === "PATCH");
  }
}

function setup() {
  const tools = new Map<
    string,
    { description: string; schema: unknown; handler: Handler }
  >();
  const server = {
    tool(name: string, description: string, schema: unknown, handler: Handler) {
      tools.set(name, { description, schema, handler });
    },
  };
  const client = new StubClient();

  registerAgreementTools(
    server as unknown as McpServer,
    client as unknown as CwManageClient,
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const result = await tool.handler(args);
    return JSON.parse(result.content[0].text);
  };

  return { tools, client, call };
}

/** An addition carrying the searched-for product, with sane billing values. */
function addition(over: Record<string, unknown> = {}) {
  return {
    id: 900,
    product: { id: 3409, identifier: "FL-FORTIFY-EPP" },
    quantity: 10,
    unitPrice: 12.5,
    unitCost: 6.25,
    extPrice: 125,
    extCost: 62.5,
    billCustomer: "Billable",
    taxableFlag: true,
    invoiceDescription: "Fortify endpoint protection",
    description: "Fortify EPP",
    uom: "Each",
    effectiveDate: "2026-01-01T00:00:00Z",
    cancelledDate: "",
    additionStatus: "Active",
    agreementStatus: "Active",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Registration and descriptions
// ---------------------------------------------------------------------------

describe("agreement tool registration", () => {
  it("registers the existing tools plus the addition tools", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([
      "cw_create_agreement_addition",
      "cw_get_agreement",
      "cw_get_agreement_additions",
      "cw_get_invoice",
      "cw_search_agreement_additions",
      "cw_search_agreements",
      "cw_search_invoices",
      "cw_update_agreement_addition",
      "cw_update_agreement_addition_product",
    ]);
  });

  it("warns on the search tool that a full scan is slow and why", () => {
    const { tools } = setup();
    const description = tools.get("cw_search_agreement_additions")!.description;
    expect(description).toMatch(/no cross-agreement additions endpoint/i);
    expect(description).toMatch(/full scan is slow/i);
  });

  it("warns on the update tool that it changes live billing", () => {
    const { tools } = setup();
    const description = tools.get(
      "cw_update_agreement_addition_product",
    )!.description;
    expect(description).toMatch(/changes live billing/i);
    expect(description).toMatch(/dryRun/);
  });
});

// ---------------------------------------------------------------------------
// cw_search_agreement_additions
// ---------------------------------------------------------------------------

describe("cw_search_agreement_additions", () => {
  /** Three agreements of three different types, one addition on two of them. */
  function scanFixture(
    additionsByAgreement: Record<number, unknown[]>,
    agreements?: unknown[],
  ): GetResponder {
    const defaultAgreements = [
      {
        id: 1,
        name: "Managed Services",
        type: { id: 5, name: "Managed Services" },
        company: { id: 100, name: "Acme" },
      },
      {
        id: 2,
        name: "Block Hours",
        type: { id: 6, name: "Block Hours" },
        company: { id: 200, name: "Globex" },
      },
      {
        id: 3,
        name: "Recurring Products",
        type: { id: 7, name: "Recurring Products" },
        company: { id: 300, name: "Initech" },
      },
    ];

    return (path) => {
      if (path === "/finance/agreements") return agreements ?? defaultAgreements;
      const match = path.match(/^\/finance\/agreements\/(\d+)\/additions$/);
      if (match) return additionsByAgreement[Number(match[1])] ?? [];
      if (path === "/procurement/catalog") {
        return [{ id: 3409, identifier: "FL-FORTIFY-EPP", description: "Fortify EPP" }];
      }
      return [];
    };
  }

  it("resolves a product identifier to an ID before scanning", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({ 1: [addition()] });

    const result = await call("cw_search_agreement_additions", {
      productIdentifier: "FL-FORTIFY-EPP",
    });

    expect(client.gets()[0]).toMatchObject({
      path: "/procurement/catalog",
      params: { conditions: "identifier = 'FL-FORTIFY-EPP'" },
    });
    expect(result.summary.productId).toBe(3409);
    expect(result.summary.productDescription).toBe("Fortify EPP");
  });

  it("escapes a quote in the identifier rather than breaking the condition", async () => {
    const { client, call } = setup();
    client.getResponder = (path) =>
      path === "/procurement/catalog" ? [{ id: 7, identifier: "O'Brien" }] : [];

    await call("cw_search_agreement_additions", { productIdentifier: "O'Brien" });

    expect(client.gets()[0].params!.conditions).toBe("identifier = 'O''Brien'");
  });

  it("rejects an identifier that matches nothing", async () => {
    const { client, call } = setup();
    client.getResponder = () => [];

    await expect(
      call("cw_search_agreement_additions", { productIdentifier: "NOPE" }),
    ).rejects.toThrow(/No catalog item found/);
  });

  it("rejects an identifier that matches more than one catalog item", async () => {
    const { client, call } = setup();
    client.getResponder = (path) =>
      path === "/procurement/catalog"
        ? [
            { id: 1, identifier: "DUP" },
            { id: 2, identifier: "DUP" },
          ]
        : [];

    await expect(
      call("cw_search_agreement_additions", { productIdentifier: "DUP" }),
    ).rejects.toThrow(/matched 2 catalog items/);
  });

  it("requires a product to search for", async () => {
    const { call } = setup();
    await expect(call("cw_search_agreement_additions", {})).rejects.toThrow(
      /productId or productIdentifier/,
    );
  });

  it("scans active agreements of every type and filters additions server side", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({
      1: [addition({ id: 901 })],
      2: [addition({ id: 902 })],
      3: [addition({ id: 903 })],
    });

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    const agreementScan = client
      .gets()
      .find((getCall) => getCall.path === "/finance/agreements")!;
    expect(agreementScan.params!.conditions).toBe("cancelledFlag = false");
    // No agreement type filter is applied, so all three types come back.
    expect(result.summary.byAgreementType).toEqual({
      "Managed Services": 1,
      "Block Hours": 1,
      "Recurring Products": 1,
    });

    const additionCalls = client
      .gets()
      .filter((getCall) => /\/additions$/.test(getCall.path));
    expect(additionCalls).toHaveLength(3);
    for (const additionCall of additionCalls) {
      expect(additionCall.params!.conditions).toBe("product/id = 3409");
      expect(additionCall.params!.pageSize).toBe(1000);
    }

    expect(result.summary.filterMode).toMatch(/ConnectWise conditions/);
    expect(result.summary.additionsReturned).toBe(3);
    expect(result.summary.agreementsWithMatches).toBe(3);
  });

  it("combines caller agreement conditions with the cancelled filter", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({});

    await call("cw_search_agreement_additions", {
      productId: 3409,
      agreementConditions: "company/id = 100",
    });

    expect(
      client.gets().find((getCall) => getCall.path === "/finance/agreements")!.params!
        .conditions,
    ).toBe("(company/id = 100) and (cancelledFlag = false)");
  });

  it("drops the cancelled filter when cancelled agreements are wanted", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({});

    await call("cw_search_agreement_additions", {
      productId: 3409,
      includeCancelledAgreements: true,
    });

    expect(
      client.gets().find((getCall) => getCall.path === "/finance/agreements")!.params!
        .conditions,
    ).toBeUndefined();
  });

  it("returns the fields a repoint needs, per addition", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({ 1: [addition({ id: 901 })] });

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    expect(result.rows[0]).toMatchObject({
      agreementId: 1,
      agreementName: "Managed Services",
      agreementType: "Managed Services",
      companyId: 100,
      company: "Acme",
      additionId: 901,
      productId: 3409,
      productIdentifier: "FL-FORTIFY-EPP",
      quantity: 10,
      unitPrice: 12.5,
      unitCost: 6.25,
      invoiceDescription: "Fortify endpoint protection",
      billCustomer: "Billable",
      taxableFlag: true,
      effectiveDate: "2026-01-01T00:00:00Z",
      cancelledDate: null,
      additionStatus: "Active",
      cancelled: false,
    });
    expect(result.summary.totalQuantity).toBe(10);
    expect(result.summary.totalExtPrice).toBe(125);
    expect(result.summary.totalExtCost).toBe(62.5);
  });

  it("excludes additions cancelled in the past but keeps a future cancellation", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({
      1: [
        addition({ id: 901, cancelledDate: "2020-06-30T00:00:00Z" }),
        addition({ id: 902, cancelledDate: "2099-06-30T00:00:00Z" }),
        addition({ id: 903 }),
      ],
    });

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    expect(result.rows.map((row: { additionId: number }) => row.additionId)).toEqual([
      902, 903,
    ]);
    expect(result.summary.cancelledAdditionsExcluded).toBe(1);
  });

  it("includes past cancellations when asked, flagged as cancelled", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({
      1: [addition({ id: 901, cancelledDate: "2020-06-30T00:00:00Z" })],
    });

    const result = await call("cw_search_agreement_additions", {
      productId: 3409,
      includeCancelledAdditions: true,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].cancelled).toBe(true);
    expect(result.summary.cancelledAdditionsExcluded).toBe(0);
    expect(result.summary.cancelledAdditionsFound).toBe(1);
  });

  it("pages an agreement with more additions than one page holds", async () => {
    const { client, call } = setup();
    const firstPage = Array.from({ length: 1000 }, (_unused, index) =>
      addition({ id: 1000 + index }),
    );
    const secondPage = [addition({ id: 2001 }), addition({ id: 2002 })];

    client.getResponder = (path, params) => {
      if (path === "/finance/agreements") {
        return [{ id: 1, name: "Big", type: { id: 5, name: "Managed Services" } }];
      }
      if (path === "/finance/agreements/1/additions") {
        return params.page === 1 ? firstPage : secondPage;
      }
      return [];
    };

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    expect(result.summary.additionsReturned).toBe(1002);
    expect(
      client.gets().filter((getCall) => getCall.path === "/finance/agreements/1/additions"),
    ).toHaveLength(2);
  });

  it("falls back to client-side filtering when the server rejects the condition", async () => {
    const { client, call } = setup();
    const additions: Record<number, unknown[]> = {
      1: [addition({ id: 901 }), addition({ id: 902, product: { id: 999 } })],
      2: [addition({ id: 903 })],
      3: [],
    };

    client.getResponder = (path, params) => {
      if (path === "/finance/agreements") {
        return [
          { id: 1, name: "One", type: { id: 5, name: "Managed Services" } },
          { id: 2, name: "Two", type: { id: 6, name: "Block Hours" } },
          { id: 3, name: "Three", type: { id: 7, name: "Recurring Products" } },
        ];
      }
      const match = path.match(/^\/finance\/agreements\/(\d+)\/additions$/);
      if (match) {
        if (params.conditions) {
          throw new Error("ConnectWise API GET returned 400: invalid condition");
        }
        return additions[Number(match[1])] ?? [];
      }
      return [];
    };

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    expect(result.summary.filterMode).toMatch(/client side/);
    expect(result.summary.warnings[0]).toMatch(/Falling back/);
    // The addition on a different product must not survive the local filter.
    expect(result.rows.map((row: { additionId: number }) => row.additionId).sort()).toEqual(
      [901, 903],
    );
  });

  it("records an unreadable agreement instead of failing the whole scan", async () => {
    const { client, call } = setup();
    client.getResponder = (path) => {
      if (path === "/finance/agreements") {
        return [
          { id: 1, name: "One", type: { id: 5, name: "Managed Services" } },
          { id: 2, name: "Two", type: { id: 5, name: "Managed Services" } },
        ];
      }
      if (path === "/finance/agreements/2/additions") {
        throw new Error("ConnectWise API GET returned 403: forbidden");
      }
      if (path === "/finance/agreements/1/additions") return [addition({ id: 901 })];
      return [];
    };

    const result = await call("cw_search_agreement_additions", { productId: 3409 });

    expect(result.summary.additionsReturned).toBe(1);
    expect(result.summary.failures).toEqual([
      { agreementId: 2, error: expect.stringContaining("403") },
    ]);
    expect(result.summary.warnings.join(" ")).toMatch(/could not be read/);
  });

  it("honours maxAgreements and says the result is partial", async () => {
    const { client, call } = setup();
    client.getResponder = scanFixture({
      1: [addition({ id: 901 })],
      2: [addition({ id: 902 })],
      3: [addition({ id: 903 })],
    });

    const result = await call("cw_search_agreement_additions", {
      productId: 3409,
      maxAgreements: 2,
    });

    expect(result.summary.agreementsScanned).toBe(2);
    expect(result.summary.agreementsAvailable).toBe(3);
    expect(result.summary.warnings.join(" ")).toMatch(/partial/);
  });
});

// ---------------------------------------------------------------------------
// cw_update_agreement_addition_product
// ---------------------------------------------------------------------------

describe("cw_update_agreement_addition_product", () => {
  const additionPath = "/finance/agreements/1/additions/900";

  /** Before on the first GET, after on the second. */
  function beforeAfter(before: unknown, after: unknown): GetResponder {
    return (path, _params, nth) => {
      if (path !== additionPath) return [];
      return nth === 0 ? before : after;
    };
  }

  it("defaults to a dry run and sends nothing", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(addition(), addition());

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
    });

    expect(client.patches()).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.warning).toMatch(/live billing/i);
    expect(result.plannedRequest).toMatchObject({
      method: "PATCH",
      path: additionPath,
    });
  });

  it("pins every billing field at its pre-change value in the planned PATCH", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(addition(), addition());

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
    });

    expect(result.plannedRequest.body).toEqual([
      { op: "replace", path: "product", value: { id: 4501 } },
      { op: "replace", path: "unitPrice", value: 12.5 },
      { op: "replace", path: "unitCost", value: 6.25 },
      { op: "replace", path: "quantity", value: 10 },
      {
        op: "replace",
        path: "invoiceDescription",
        value: "Fortify endpoint protection",
      },
      { op: "replace", path: "taxableFlag", value: true },
      { op: "replace", path: "billCustomer", value: "Billable" },
    ]);
  });

  it("pins a zero price rather than dropping it", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(
      addition({ unitPrice: 0, unitCost: 0, taxableFlag: false }),
      addition(),
    );

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
    });

    expect(result.pinnedValues).toMatchObject({
      unitPrice: 0,
      unitCost: 0,
      taxableFlag: false,
    });
  });

  it("reports a billing field ConnectWise did not return as unpinned", async () => {
    const { client, call } = setup();
    const partial = addition();
    delete (partial as Record<string, unknown>).taxableFlag;
    client.getResponder = beforeAfter(partial, partial);

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
    });

    expect(result.missingPinnedFields).toEqual(["taxableFlag"]);
    expect(result.notes.join(" ")).toMatch(/not pinned/);
  });

  it("refuses the update when the current product is not the expected one", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(addition(), addition());

    await expect(
      call("cw_update_agreement_addition_product", {
        agreementId: 1,
        additionId: 900,
        newProductId: 4501,
        expectedCurrentProductId: 1234,
        dryRun: false,
      }),
    ).rejects.toThrow(/not the expected 1234/);
    expect(client.patches()).toHaveLength(0);
  });

  it("flags a repoint that would be a no-op", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(addition(), addition());

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 3409,
    });

    expect(result.alreadyCorrect).toBe(true);
    expect(result.notes.join(" ")).toMatch(/no-op/);
  });

  it("sends the PATCH, reads back and compares every field", async () => {
    const { client, call } = setup();
    const before = addition();
    const after = addition({
      product: { id: 4501, identifier: "FL-FORTIFY-EPP-2" },
      // ConnectWise derives these from the new product, so they are expected.
      description: "Fortify EPP v2",
      uom: "Unit",
    });
    client.getResponder = beforeAfter(before, after);

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
      expectedCurrentProductId: 3409,
      dryRun: false,
    });

    expect(client.patches()).toHaveLength(1);
    expect(client.patches()[0].path).toBe(additionPath);
    // Read, patch, read.
    expect(client.gets().filter((getCall) => getCall.path === additionPath)).toHaveLength(
      2,
    );

    expect(result.sent).toBe(true);
    expect(result.productChanged).toBe(true);
    expect(result.previousProductId).toBe(3409);
    expect(result.newProductId).toBe(4501);

    // Every field on either snapshot appears in the comparison.
    const compared = result.comparison.map((entry: { field: string }) => entry.field);
    expect(compared).toEqual([...new Set(Object.keys(before))].sort());
    expect(result.comparison.find((entry: { field: string }) => entry.field === "quantity"))
      .toMatchObject({ before: 10, after: 10, changed: false });

    // Derived changes are separated from the ones worth chasing.
    expect(
      result.derivedChanges.map((entry: { field: string }) => entry.field).sort(),
    ).toEqual(["description", "uom"]);
    expect(result.unexpectedChangeCount).toBe(0);
  });

  it("flags a billing field that changed despite being pinned", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(
      addition(),
      addition({
        product: { id: 4501, identifier: "FL-FORTIFY-EPP-2" },
        // ConnectWise repriced the line off the new product anyway.
        unitPrice: 19.95,
        billCustomer: "DoNotBill",
      }),
    );

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
      dryRun: false,
    });

    expect(result.unexpectedChangeCount).toBe(2);
    expect(
      result.unexpectedChanges.map((entry: { field: string }) => entry.field).sort(),
    ).toEqual(["billCustomer", "unitPrice"]);
    expect(
      result.unexpectedChanges.find(
        (entry: { field: string }) => entry.field === "unitPrice",
      ),
    ).toMatchObject({ before: 12.5, after: 19.95, changed: true });
    expect(result.notes.join(" ")).toMatch(/should not have/);
  });

  it("does not flag the product reference itself as an unexpected change", async () => {
    const { client, call } = setup();
    client.getResponder = beforeAfter(
      addition(),
      addition({ product: { id: 4501, identifier: "FL-FORTIFY-EPP-2" } }),
    );

    const result = await call("cw_update_agreement_addition_product", {
      agreementId: 1,
      additionId: 900,
      newProductId: 4501,
      dryRun: false,
    });

    expect(result.unexpectedChanges).toEqual([]);
    expect(result.derivedChanges).toEqual([]);
    expect(result.productChanged).toBe(true);
  });
});
