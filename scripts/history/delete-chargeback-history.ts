// Deletes chargeback history (ADR-0044) from chargebackDaily by month, optionally one person's documents only, for
// privacy and data minimisation (docs/operate/chargeback-history-changes.md#delete-history). Counts only (what-if)
// unless --confirm is given.
//
//   node scripts/history/delete-chargeback-history.ts --endpoint https://<account>.documents.azure.com:443/
//     --database <database> --month 2025-01 [--month 2025-02] [--person <personId>] [--confirm]
//
// A whole month: its coverage record is deleted first, then its documents, so a run stopped half-way leaves the month
// refused by the export (history_not_covered) rather than reported as covered with documents missing. One person: the
// coverage record first notes the deletion (personDeletions, without the person's ID), then that person's documents
// are deleted; the month stays covered and its totals no longer include that person. The previous month and later
// are refused: the reconciler may still write them and would recreate deleted days from Log Analytics.
import { pathToFileURL } from "node:url";

export const COVERAGE_ID = "coverage";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERSON = /^[0-9A-Za-z._@-]{1,128}$/;

export interface CoverageRead {
  doc: Record<string, unknown>;
  etag: string;
}

// The Cosmos DB operations the tool needs on chargebackDaily (partition key /month).
export interface HistoryDeleteContainer {
  // IDs of the month's documents, the coverage record excluded; only one person's when personId is set.
  listIds(month: string, personId: string | null): Promise<string[]>;
  deleteItem(id: string, month: string): Promise<void>;
  readCoverage(month: string): Promise<CoverageRead | null>;
  // Both conditional on etag (If-Match), so a concurrent reconciler write is never overwritten.
  replaceCoverage(doc: Record<string, unknown>, etag: string): Promise<void>;
  deleteCoverage(month: string, etag: string): Promise<void>;
}

export interface DeleteOptions {
  months: string[];
  personId: string | null;
  confirm: boolean;
  now: Date;
}

export interface MonthResult {
  month: string;
  documents: number;
  deleted: number;
  coverage: "none" | "kept" | "deleted" | "noted";
}

export class DeleteRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "DeleteRefused";
  }
}

// The first month the tool leaves alone: the previous UTC month (the reconciler reads its last days early in a month).
export function firstProtectedMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function checkOptions(options: DeleteOptions): void {
  if (options.months.length === 0) throw new DeleteRefused("history_delete_usage", "name at least one --month YYYY-MM");
  const bad = options.months.filter((m) => !MONTH.test(m));
  if (bad.length) throw new DeleteRefused("history_delete_usage", `months must be YYYY-MM: ${bad.join(", ")}`);
  if (options.personId !== null && !PERSON.test(options.personId)) throw new DeleteRefused("history_delete_usage", "--person must be the personId stored in the documents");
  const protectedFrom = firstProtectedMonth(options.now);
  const recent = options.months.filter((m) => m >= protectedFrom);
  if (recent.length) throw new DeleteRefused("history_month_too_recent", `${recent.join(", ")}: the reconciler may still write months from ${protectedFrom} on; delete them after the next month ends`);
}

export async function deleteHistory(container: HistoryDeleteContainer, options: DeleteOptions): Promise<MonthResult[]> {
  // History stores personId in lower case (keyOf in src/reconciler/history.ts); an Entra object ID pasted in upper
  // case must still match, or a deletion request would silently delete nothing.
  options = { ...options, personId: options.personId === null ? null : options.personId.toLowerCase() };
  checkOptions(options);
  const results: MonthResult[] = [];
  for (const month of [...new Set(options.months)].sort()) {
    const ids = await container.listIds(month, options.personId);
    const coverage = await container.readCoverage(month);
    const result: MonthResult = { month, documents: ids.length, deleted: 0, coverage: coverage === null ? "none" : "kept" };
    results.push(result);
    if (!options.confirm || (options.personId !== null && ids.length === 0)) continue;
    if (coverage !== null && options.personId === null) {
      await container.deleteCoverage(month, coverage.etag);
      result.coverage = "deleted";
    } else if (coverage !== null) {
      const noted = Array.isArray(coverage.doc.personDeletions) ? coverage.doc.personDeletions : [];
      await container.replaceCoverage({ ...coverage.doc, personDeletions: [...noted, { deletedAt: options.now.toISOString(), documents: ids.length }] }, coverage.etag);
      result.coverage = "noted";
    }
    for (const id of ids) {
      await container.deleteItem(id, month);
      result.deleted += 1;
    }
  }
  return results;
}

export interface CliArgs extends Omit<DeleteOptions, "now"> {
  endpoint: string;
  database: string;
  container: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { endpoint: "", database: "", container: "chargebackDaily", months: [], personId: null, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--confirm") args.confirm = true;
    else if (flag === "--what-if") args.confirm = false;
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new DeleteRefused("history_delete_usage", `${flag} needs a value`);
      if (flag === "--endpoint") args.endpoint = value;
      else if (flag === "--database") args.database = value;
      else if (flag === "--container") args.container = value;
      else if (flag === "--month") args.months.push(value);
      else if (flag === "--person") args.personId = value.toLowerCase();
      else throw new DeleteRefused("history_delete_usage", `unknown option ${flag}`);
    }
  }
  if (!/^https:\/\/[a-z0-9-]+\.documents\.azure\.com(:443)?\/?$/.test(args.endpoint)) throw new DeleteRefused("history_delete_usage", "--endpoint must be https://<account>.documents.azure.com:443/");
  if (!args.database) throw new DeleteRefused("history_delete_usage", "--database is required");
  return args;
}

const statusOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

// Microsoft Entra ID through DefaultAzureCredential: the account takes no keys (local authentication is disabled).
async function cosmosContainer(args: CliArgs): Promise<HistoryDeleteContainer> {
  const { CosmosClient } = await import("@azure/cosmos");
  const { DefaultAzureCredential } = await import("@azure/identity");
  const container = new CosmosClient({ endpoint: args.endpoint, aadCredentials: new DefaultAzureCredential() }).database(args.database).container(args.container);
  return {
    async listIds(month, personId) {
      const spec = personId === null
        ? { query: "SELECT c.id FROM c" }
        : { query: "SELECT c.id FROM c WHERE c.personId = @person", parameters: [{ name: "@person", value: personId }] };
      const { resources } = await container.items.query<{ id: string }>(spec, { partitionKey: month }).fetchAll();
      return resources.map((r) => r.id).filter((id) => id !== COVERAGE_ID);
    },
    async deleteItem(id, month) {
      try {
        await container.item(id, month).delete();
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    },
    async readCoverage(month) {
      try {
        const { resource, etag } = await container.item(COVERAGE_ID, month).read<Record<string, unknown>>();
        return resource === undefined ? null : { doc: resource, etag };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async replaceCoverage(doc, etag) {
      await container.item(COVERAGE_ID, String(doc.month)).replace(doc, { accessCondition: { type: "IfMatch", condition: etag } });
    },
    async deleteCoverage(month, etag) {
      await container.item(COVERAGE_ID, month).delete({ accessCondition: { type: "IfMatch", condition: etag } });
    },
  };
}

export async function main(argv: readonly string[], now = new Date()): Promise<number> {
  try {
    const args = parseArgs(argv);
    checkOptions({ ...args, now });
    const results = await deleteHistory(await cosmosContainer(args), { ...args, now });
    for (const r of results) console.log(JSON.stringify({ schema: "ccof.history.delete.v1", mode: args.confirm ? "confirm" : "what-if", byPerson: args.personId !== null, ...r }));
    if (!args.confirm) console.log("what-if: nothing was deleted; add --confirm to delete.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof DeleteRefused ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
