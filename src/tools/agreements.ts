import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import {
  fetchAllPages,
  mapWithConcurrency,
  andConditions,
  round2,
  type Reference,
} from "./paging.js";

/**
 * Finance agreement tools (ConnectWise Finance API).
 *
 * Agreement additions are the recurring billing lines on an agreement. Field
 * names here are taken from the ConnectWise Manage OpenAPI spec (Addition,
 * IvItemReference and Agreement). Three things about that spec shape the tools
 * below:
 *
 * 1. There is no cross-agreement additions endpoint. The spec exposes additions
 *    only as children of one agreement: /finance/agreements/{parentId}/additions,
 *    its /count sibling, and /additions/{id}. Finding every addition carrying a
 *    given catalog item therefore means iterating agreements and querying each
 *    one, which is why cw_search_agreement_additions is a scan rather than a
 *    single query.
 * 2. The Addition product reference is an IvItemReference, which carries id,
 *    identifier and serializedFlag only. There is no name on it, so the human
 *    readable text for a line comes from the addition's own description and
 *    invoiceDescription fields.
 * 3. Addition carries both an additionStatus and an agreementStatus enum
 *    (Active, Cancelled, Expired, Inactive) alongside effectiveDate and
 *    cancelledDate. The dates are the authority for whether a line still bills,
 *    so they are what the active filter uses, but both statuses are reported so
 *    a caller can see where ConnectWise disagrees with the dates.
 *
 * Only product is repointed by cw_update_agreement_addition_product. Every
 * other billing field is re-sent at its pre-change value in the same request,
 * because ConnectWise otherwise defaults price, cost and description from the
 * new catalog item and silently reprices the line.
 */

/** Agreements are scanned concurrently, kept low so a wide scan does not trip API rate limits. */
const AGREEMENT_SCAN_CONCURRENCY = 4;

/**
 * Billing fields re-sent at their pre-change values whenever a product is
 * repointed, so ConnectWise cannot default them from the new catalog item.
 */
const PINNED_BILLING_FIELDS = [
  "unitPrice",
  "unitCost",
  "quantity",
  "invoiceDescription",
  "taxableFlag",
  "billCustomer",
] as const;

/**
 * Fields ConnectWise derives from the product or from the pinned values, so a
 * change in one of these after a repoint is expected rather than a surprise.
 * They are still reported, just kept separate from the changes worth chasing.
 */
const DERIVED_FIELDS = new Set([
  "description",
  "uom",
  "extPrice",
  "extCost",
  "margin",
  "prorateCost",
  "proratePrice",
  "extendedProrateCost",
  "extendedProratePrice",
  "billedQuantity",
  "serialNumber",
  "_info",
]);

interface AdditionRecord {
  id?: number;
  product?: Reference & { serializedFlag?: boolean };
  quantity?: number | null;
  unitPrice?: number | null;
  unitCost?: number | null;
  billCustomer?: string | null;
  effectiveDate?: string;
  cancelledDate?: string;
  taxableFlag?: boolean | null;
  invoiceDescription?: string;
  description?: string;
  uom?: string;
  extPrice?: number | null;
  extCost?: number | null;
  agreementId?: number | null;
  additionStatus?: string | null;
  agreementStatus?: string | null;
  [key: string]: unknown;
}

interface AgreementRecord {
  id?: number;
  name?: string;
  type?: Reference;
  company?: Reference;
  cancelledFlag?: boolean;
}

interface CatalogItemRecord {
  id?: number;
  identifier?: string;
  description?: string;
}

/** Escape a value for use inside a quoted ConnectWise conditions string. */
function quoteCondition(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Normalise a ConnectWise date string. An unset date-time comes back as an
 * empty string rather than null, which reads as a value when it is not one.
 */
function dateOrNull(value: string | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

/** True when the addition carries a cancelledDate that has already passed. */
function isCancelled(addition: AdditionRecord, now: number): boolean {
  if (!addition.cancelledDate) return false;
  const cancelled = Date.parse(addition.cancelledDate);
  return Number.isFinite(cancelled) && cancelled <= now;
}

/** Structural equality, so a nested product reference compares sensibly. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// RFC 6902 requires a "value" member on add/replace but forbids relying on it
// for remove. A flat z.object with an optional value let a caller omit it on
// add/replace: applyPatchLocally would silently drop the field (undefined
// isn't serialized), producing a preview that looks fine while the live
// PATCH request goes out missing a member Manage requires. The discriminated
// union makes that combination unrepresentable instead of just undocumented.
//
// z.unknown() alone accepts `undefined` even when not marked .optional() —
// Zod treats an absent key the same as a present key valued `undefined` for
// an unknown/any field, so plain `value: z.unknown()` would NOT actually
// reject a missing value (confirmed by hand: it let `{ op: "replace", path:
// "quantity" }` straight through to the live fetch call, which then crashed
// on a mocked-undefined response instead of failing schema validation). The
// refine makes "present and not undefined" an explicit condition.
const requiredValue = z.unknown().refine((v) => v !== undefined, {
  message: "value is required for add/replace operations (RFC 6902)",
});

const additionPatchOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: requiredValue.describe("New value"),
  }),
  z.object({
    op: z.literal("replace"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: requiredValue.describe("New value"),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string().describe("Field path (e.g. 'quantity', 'billCustomer', 'cancelledDate')"),
    value: z.unknown().optional().describe("Unused for remove"),
  }),
]);

type AdditionPatchOperation = z.infer<typeof additionPatchOperation>;

/**
 * Applies flat-field JSON Patch operations to a record in memory, matching
 * the same simple-path convention (top-level field names, not nested JSON
 * Pointers) that cw_update_time_entry documents. Used for cw_update_agreement_addition's
 * dryRun mode so a preview never has to round-trip through Manage.
 */
export function applyPatchLocally(
  record: Record<string, unknown>,
  operations: AdditionPatchOperation[],
): Record<string, unknown> {
  const patched = { ...record };
  for (const { op, path, value } of operations) {
    const field = path.replace(/^\//, "");
    if (op === "remove") {
      delete patched[field];
    } else {
      patched[field] = value;
    }
  }
  return patched;
}

export function registerAgreementTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_agreements",
    "Search finance agreements (recurring revenue contracts) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"cancelledFlag = false\", \"company/name = 'Acme'\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/agreements", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement",
    "Get a specific finance agreement by ID.",
    {
      id: z.number().describe("Agreement ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/agreements/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement_additions",
    "Get additions (line items) for a specific agreement.",
    {
      agreementId: z.number().describe("Agreement ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ agreementId, page, pageSize }) => {
      const result = await client.get(`/finance/agreements/${agreementId}/additions`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_agreement_addition",
    "Update an agreement addition (recurring line item) with JSON Patch (Manage PATCH /finance/agreements/{agreementId}/additions/{additionId}). Use this for seat-count reconciliation and similar corrections. Common paths: quantity, effectiveDate, cancelledDate, billCustomer ('Billable' | 'DoNotBill' | 'NoCharge'), description, invoiceDescription, unitPrice, unitCost. Set dryRun to preview the result without saving.",
    {
      agreementId: z.number().describe("Agreement ID"),
      additionId: z.number().describe("Addition (line item) ID"),
      operations: z.array(additionPatchOperation).describe("JSON Patch operations applied to the addition"),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, fetch the current addition, apply the patch locally, and return the would-be result without calling Manage (no write is made)."),
    },
    async ({ agreementId, additionId, operations, dryRun }) => {
      const path = `/finance/agreements/${agreementId}/additions/${additionId}`;
      if (dryRun) {
        const current = await client.get<Record<string, unknown>>(path);
        const preview = applyPatchLocally(current, operations);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ dryRun: true, saved: false, preview }, null, 2),
            },
          ],
        };
      }
      const result = await client.patch(path, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_agreement_addition",
    "Create a new addition (recurring line item) on an agreement (Manage POST /finance/agreements/{agreementId}/additions). Requires a catalog item (productId) and billCustomer. NOTE: field coverage here was verified against a community-maintained ConnectWise Manage type reference, not the official REST docs directly -- if Manage rejects the create with a validation error on a field not listed here, that field is real but missing from this tool's schema.",
    {
      agreementId: z.number().describe("Agreement ID"),
      productId: z.number().describe("Catalog item (product) ID to add"),
      billCustomer: z.enum(["Billable", "DoNotBill", "NoCharge"]).describe("Billing treatment for this addition"),
      quantity: z.number().optional().describe("Quantity"),
      description: z.string().optional().describe("Line description"),
      invoiceDescription: z.string().optional().describe("Description shown on the invoice"),
      effectiveDate: z.string().optional().describe("Effective date (ISO 8601)"),
      cancelledDate: z.string().optional().describe("Cancelled date (ISO 8601)"),
      unitPrice: z.number().optional().describe("Unit price"),
      unitCost: z.number().optional().describe("Unit cost"),
      taxableFlag: z.boolean().optional().describe("Whether this addition is taxable"),
      uom: z.string().optional().describe("Unit of measure"),
    },
    async ({
      agreementId,
      productId,
      billCustomer,
      quantity,
      description,
      invoiceDescription,
      effectiveDate,
      cancelledDate,
      unitPrice,
      unitCost,
      taxableFlag,
      uom,
    }) => {
      const body: Record<string, unknown> = {
        product: { id: productId },
        billCustomer,
      };
      if (quantity !== undefined) body.quantity = quantity;
      if (description) body.description = description;
      if (invoiceDescription) body.invoiceDescription = invoiceDescription;
      if (effectiveDate) body.effectiveDate = effectiveDate;
      if (cancelledDate) body.cancelledDate = cancelledDate;
      if (unitPrice !== undefined) body.unitPrice = unitPrice;
      if (unitCost !== undefined) body.unitCost = unitCost;
      if (taxableFlag !== undefined) body.taxableFlag = taxableFlag;
      if (uom) body.uom = uom;

      const result = await client.post(`/finance/agreements/${agreementId}/additions`, body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_invoices",
    "Search invoices in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"company/name = 'Acme'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/invoices", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice",
    "Get a specific invoice by ID.",
    {
      id: z.number().describe("Invoice ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/invoices/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // Addition scan and product repoint
  // -------------------------------------------------------------------------

  server.tool(
    "cw_search_agreement_additions",
    "Find every agreement addition (recurring billing line) carrying one catalog item, across all agreements. Give either productId or productIdentifier. ConnectWise exposes additions only as children of a single agreement and has no cross-agreement additions endpoint, so this iterates agreements and queries each one: A FULL SCAN IS SLOW, roughly one API call per agreement, so an instance with hundreds of agreements takes minutes. Narrow it with agreementConditions where you can, or set maxAgreements to sanity check first. No agreement type filter is applied, so agreements of every type are included, and the summary counts the matches by type so you can see that. Active agreements only by default (cancelledFlag = false); set includeCancelledAgreements to widen. Additions whose cancelledDate has already passed are excluded unless includeCancelledAdditions is set. Each row gives the agreement ID, name, type and company, the addition ID, the product ID and identifier, quantity, unitPrice, unitCost, invoiceDescription, billCustomer, taxableFlag, effectiveDate and cancelledDate. Dates are the raw ConnectWise values, which are UTC. Read-only.",
    {
      productId: z
        .number()
        .optional()
        .describe("Catalog item ID to search for. Give this or productIdentifier"),
      productIdentifier: z
        .string()
        .optional()
        .describe(
          "Catalog item identifier to search for (e.g. 'FL-FORTIFY-EPP'). Resolved to an ID against /procurement/catalog first. Give this or productId",
        ),
      includeCancelledAdditions: z
        .boolean()
        .optional()
        .describe(
          "Include additions whose cancelledDate has already passed (default: false)",
        ),
      includeCancelledAgreements: z
        .boolean()
        .optional()
        .describe(
          "Scan agreements flagged cancelled as well (default: false). Widens the scan and makes it slower",
        ),
      agreementConditions: z
        .string()
        .optional()
        .describe(
          "Extra ConnectWise conditions on the agreement scan, to narrow it (e.g. \"company/id = 42\"). Combined with the cancelled filter",
        ),
      maxAgreements: z
        .number()
        .optional()
        .describe(
          "Stop after scanning this many agreements. Use it to sanity check a query before running the full scan",
        ),
    },
    async ({
      productId,
      productIdentifier,
      includeCancelledAdditions,
      includeCancelledAgreements,
      agreementConditions,
      maxAgreements,
    }) => {
      if (productId === undefined && !productIdentifier) {
        throw new Error("Give either productId or productIdentifier.");
      }

      const warnings: string[] = [];

      // 1. Resolve the catalog item. An identifier has to be turned into an ID
      //    because the addition's product reference is filtered on ID.
      let resolvedId = productId;
      let resolvedItem: CatalogItemRecord | undefined;

      if (productIdentifier) {
        const matches = await fetchAllPages<CatalogItemRecord>(
          client,
          "/procurement/catalog",
          { conditions: `identifier = ${quoteCondition(productIdentifier)}` },
        );
        if (matches.length === 0) {
          throw new Error(
            `No catalog item found with identifier '${productIdentifier}'.`,
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `Identifier '${productIdentifier}' matched ${matches.length} catalog items (IDs ${matches
              .map((m) => m.id)
              .join(", ")}). Pass productId instead.`,
          );
        }
        resolvedItem = matches[0];
        if (productId !== undefined && productId !== resolvedItem.id) {
          throw new Error(
            `productId ${productId} and productIdentifier '${productIdentifier}' (ID ${resolvedItem.id}) disagree. Pass one or the other.`,
          );
        }
        resolvedId = resolvedItem.id;
      }

      if (typeof resolvedId !== "number") {
        throw new Error("Could not resolve the catalog item to an ID.");
      }
      const targetProductId = resolvedId;

      // 2. List the agreements to scan. No type filter, deliberately.
      const agreements = await fetchAllPages<AgreementRecord>(
        client,
        "/finance/agreements",
        {
          conditions: andConditions(
            agreementConditions,
            includeCancelledAgreements ? undefined : "cancelledFlag = false",
          ),
          orderBy: "id asc",
        },
      );

      const scannable = agreements.filter((a) => typeof a.id === "number");
      const scanned =
        typeof maxAgreements === "number"
          ? scannable.slice(0, Math.max(0, maxAgreements))
          : scannable;

      if (scanned.length < scannable.length) {
        warnings.push(
          `maxAgreements limited the scan to ${scanned.length} of ${scannable.length} agreements, so this result is partial.`,
        );
      }

      // 3. Query each agreement's additions. The preferred path filters on the
      //    product server side. If ConnectWise rejects that condition, fall
      //    back to reading every addition and filtering here, and stop retrying
      //    the server-side form for the rest of the scan.
      const productFilter = `product/id = ${targetProductId}`;
      let serverSideFilter = true;
      const failures: Array<{ agreementId: number; error: string }> = [];

      const perAgreement = await mapWithConcurrency(
        scanned,
        AGREEMENT_SCAN_CONCURRENCY,
        async (agreement) => {
          const path = `/finance/agreements/${agreement.id}/additions`;

          if (serverSideFilter) {
            try {
              return {
                agreement,
                additions: await fetchAllPages<AdditionRecord>(client, path, {
                  conditions: productFilter,
                }),
              };
            } catch (err) {
              serverSideFilter = false;
              warnings.push(
                `Server-side product filter was rejected on agreement ${agreement.id} (${errorMessage(
                  err,
                )}). Falling back to reading every addition and filtering client side, which is slower.`,
              );
            }
          }

          try {
            const all = await fetchAllPages<AdditionRecord>(client, path);
            return {
              agreement,
              additions: all.filter((a) => a.product?.id === targetProductId),
            };
          } catch (err) {
            failures.push({
              agreementId: agreement.id as number,
              error: errorMessage(err),
            });
            return { agreement, additions: [] as AdditionRecord[] };
          }
        },
      );

      // 4. Flatten, then drop additions already cancelled unless asked for.
      const now = Date.now();
      let cancelledExcluded = 0;

      const rows = perAgreement
        .flatMap(({ agreement, additions }) =>
          additions.map((addition) => ({ agreement, addition })),
        )
        .filter(({ addition }) => {
          if (isCancelled(addition, now)) {
            cancelledExcluded++;
            return includeCancelledAdditions === true;
          }
          return true;
        })
        .map(({ agreement, addition }) => ({
          agreementId: agreement.id ?? null,
          agreementName: agreement.name ?? null,
          agreementType: agreement.type?.name ?? null,
          companyId: agreement.company?.id ?? null,
          company: agreement.company?.name ?? null,
          additionId: addition.id ?? null,
          productId: addition.product?.id ?? null,
          productIdentifier: addition.product?.identifier ?? null,
          description: addition.description ?? null,
          invoiceDescription: addition.invoiceDescription ?? null,
          quantity: addition.quantity ?? null,
          unitPrice: addition.unitPrice ?? null,
          unitCost: addition.unitCost ?? null,
          extPrice: addition.extPrice ?? null,
          extCost: addition.extCost ?? null,
          billCustomer: addition.billCustomer ?? null,
          taxableFlag: addition.taxableFlag ?? null,
          effectiveDate: dateOrNull(addition.effectiveDate),
          cancelledDate: dateOrNull(addition.cancelledDate),
          additionStatus: addition.additionStatus ?? null,
          agreementStatus: addition.agreementStatus ?? null,
          cancelled: isCancelled(addition, now),
        }));

      const byAgreementType: Record<string, number> = {};
      for (const row of rows) {
        const key = row.agreementType ?? "(no type)";
        byAgreementType[key] = (byAgreementType[key] ?? 0) + 1;
      }

      const sum = (pick: (row: (typeof rows)[number]) => number | null) =>
        round2(rows.reduce((total, row) => total + (pick(row) ?? 0), 0));

      if (failures.length > 0) {
        warnings.push(
          `${failures.length} agreement(s) could not be read, so their additions are missing from this result.`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summary: {
                  productId: targetProductId,
                  productIdentifier:
                    resolvedItem?.identifier ??
                    rows.find((row) => row.productIdentifier)?.productIdentifier ??
                    null,
                  productDescription: resolvedItem?.description ?? null,
                  agreementsScanned: scanned.length,
                  agreementsAvailable: scannable.length,
                  agreementsWithMatches: new Set(rows.map((row) => row.agreementId))
                    .size,
                  additionsReturned: rows.length,
                  cancelledAdditionsFound: cancelledExcluded,
                  cancelledAdditionsExcluded: includeCancelledAdditions
                    ? 0
                    : cancelledExcluded,
                  byAgreementType,
                  totalQuantity: sum((row) => row.quantity),
                  totalExtPrice: sum((row) => row.extPrice),
                  totalExtCost: sum((row) => row.extCost),
                  filterMode: serverSideFilter
                    ? "ConnectWise conditions (product/id) per agreement"
                    : "client side, after reading every addition on each agreement",
                  ...(warnings.length > 0 ? { warnings } : {}),
                  ...(failures.length > 0 ? { failures } : {}),
                },
                rows,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "cw_update_agreement_addition_product",
    "Repoint one agreement addition to a different catalog item, holding its billing values steady. THIS CHANGES LIVE BILLING: an agreement addition is what the customer is invoiced for on the next cycle, so a wrong product, price or quantity here lands on a real invoice. Confirm with the user before running it with dryRun = false. dryRun defaults to true and returns the planned PATCH without sending anything. The live path reads the addition, then sends one PATCH that sets product to the new ID and re-sends unitPrice, unitCost, quantity, invoiceDescription, taxableFlag and billCustomer at their pre-change values, because ConnectWise otherwise defaults those from the new catalog item and silently reprices the line. It then reads the addition back and returns a before/after comparison of every field, flagging everything that changed other than product. Some of those changes are expected: ConnectWise derives description, uom, extPrice, extCost and margin from the product and the pinned values, so they are reported separately from the changes that need investigating.",
    {
      agreementId: z.number().describe("ID of the agreement holding the addition"),
      additionId: z.number().describe("ID of the addition to repoint"),
      newProductId: z.number().describe("Catalog item ID to point the addition at"),
      expectedCurrentProductId: z
        .number()
        .optional()
        .describe(
          "Safety check: the update is refused unless the addition currently carries this product ID. Use it when the addition ID came from an earlier scan",
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "Return the planned PATCH body without sending it (default: true). Set false only after the dry run has been reviewed",
        ),
    },
    async ({
      agreementId,
      additionId,
      newProductId,
      expectedCurrentProductId,
      dryRun,
    }) => {
      const isDryRun = dryRun ?? true;
      const path = `/finance/agreements/${agreementId}/additions/${additionId}`;

      // a. Read the addition first: the pre-change values are what get pinned.
      const before = await client.get<AdditionRecord>(path);

      const currentProductId = before?.product?.id ?? null;
      if (
        expectedCurrentProductId !== undefined &&
        currentProductId !== expectedCurrentProductId
      ) {
        throw new Error(
          `Addition ${additionId} on agreement ${agreementId} carries product ${currentProductId}, not the expected ${expectedCurrentProductId}. Refusing to update.`,
        );
      }

      const alreadyCorrect = currentProductId === newProductId;

      // b. Build the PATCH: the product change, plus every billing field
      //    re-sent at its pre-change value in the same request.
      const missingPinnedFields: string[] = [];
      const pinnedValues: Record<string, unknown> = {};

      const operations: Array<{ op: string; path: string; value: unknown }> = [
        { op: "replace", path: "product", value: { id: newProductId } },
      ];

      for (const field of PINNED_BILLING_FIELDS) {
        if (before && field in before) {
          const value = before[field] ?? null;
          pinnedValues[field] = value;
          operations.push({ op: "replace", path: field, value });
        } else {
          missingPinnedFields.push(field);
        }
      }

      const notes: string[] = [];
      if (missingPinnedFields.length > 0) {
        const plural = missingPinnedFields.length > 1;
        notes.push(
          `ConnectWise did not return ${missingPinnedFields.join(", ")} on the addition, so ${
            plural ? "they were" : "it was"
          } not pinned and ConnectWise may default ${
            plural ? "them" : "it"
          } from the new product.`,
        );
      }
      if (alreadyCorrect) {
        notes.push(
          `Addition ${additionId} already carries product ${newProductId}, so the repoint is a no-op. The pinned values would still be re-sent.`,
        );
      }

      // d. A dry run stops here, before anything is sent.
      if (isDryRun) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dryRun: true,
                  sent: false,
                  warning:
                    "Nothing was sent. Running this with dryRun = false changes live billing on this agreement.",
                  agreementId,
                  additionId,
                  currentProductId,
                  newProductId,
                  alreadyCorrect,
                  plannedRequest: { method: "PATCH", path, body: operations },
                  pinnedValues,
                  ...(missingPinnedFields.length > 0 ? { missingPinnedFields } : {}),
                  ...(notes.length > 0 ? { notes } : {}),
                  before,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      await client.patch(path, operations);

      // c. Read it back and compare every field.
      const after = await client.get<AdditionRecord>(path);

      const fields = [
        ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
      ].sort();

      const comparison = fields.map((field) => {
        const beforeValue = before?.[field] ?? null;
        const afterValue = after?.[field] ?? null;
        return {
          field,
          before: beforeValue,
          after: afterValue,
          changed: !deepEqual(beforeValue, afterValue),
        };
      });

      const changedOtherThanProduct = comparison.filter(
        (entry) => entry.changed && entry.field !== "product",
      );
      const unexpectedChanges = changedOtherThanProduct.filter(
        (entry) => !DERIVED_FIELDS.has(entry.field),
      );
      const derivedChanges = changedOtherThanProduct.filter((entry) =>
        DERIVED_FIELDS.has(entry.field),
      );
      const productChanged =
        comparison.find((entry) => entry.field === "product")?.changed ?? false;

      if (unexpectedChanges.length > 0) {
        notes.push(
          `${unexpectedChanges.length} field(s) changed that should not have: ${unexpectedChanges
            .map((entry) => entry.field)
            .join(", ")}. Check the invoice impact and correct them before the next billing run.`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                dryRun: false,
                sent: true,
                agreementId,
                additionId,
                productChanged,
                previousProductId: currentProductId,
                newProductId,
                sentRequest: { method: "PATCH", path, body: operations },
                pinnedValues,
                ...(missingPinnedFields.length > 0 ? { missingPinnedFields } : {}),
                unexpectedChangeCount: unexpectedChanges.length,
                unexpectedChanges,
                derivedChanges,
                ...(notes.length > 0 ? { notes } : {}),
                comparison,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
