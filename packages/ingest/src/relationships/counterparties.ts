import { throwIfAborted } from "@ma/core";
import {
  companies,
  companyGroupMemberships,
  counterparties,
  counterpartyAliases,
  counterpartyIdentifiers,
  type Db,
  eq,
  fencedTransaction,
  inArray,
  isNull,
  or,
  relationshipBlocks,
  sql,
  type Tx,
} from "@ma/db";
import {
  aliasesFor,
  CURATED_COUNTERPARTIES,
  groupKeyFor,
  symbolAliasesFor,
} from "../data/company-aliases.js";
import {
  type AliasEntry,
  type AliasMatcher,
  buildAliasMatcher,
  type CounterpartyKind,
  normalizeCompanyName,
} from "../extract/relationships.js";

export interface CounterpartySyncResult {
  listed: number;
  curated: number;
  aliases: number;
  identifiers: number;
  memberships: number;
}

interface AliasRow {
  counterpartyId: number;
  alias: string;
  normalizedAlias: string;
  source: "registry" | "curated";
  approved: boolean;
  exactCase: boolean;
}

const BATCH = 500;

export async function syncCounterparties(
  db: Db,
  signal?: AbortSignal,
): Promise<CounterpartySyncResult> {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      nseSymbol: companies.nseSymbol,
      bseCode: companies.bseCode,
      isin: companies.isin,
      industry: companies.industry,
      sector: companies.sector,
    })
    .from(companies);
  throwIfAborted(signal);
  return fencedTransaction(
    db,
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('counterparties_sync'))`);
      const existing = await tx
        .select({
          id: counterparties.id,
          companyId: counterparties.companyId,
          normalizedName: counterparties.normalizedName,
        })
        .from(counterparties);
      const byCompany = new Map(
        existing.flatMap((c) => (c.companyId === null ? [] : [[c.companyId, c.id] as const])),
      );
      const byName = new Map(existing.map((c) => [c.normalizedName, c] as const));
      const idOf = new Map<number, number>();
      for (const c of rows) {
        const base = normalizeCompanyName(c.name);
        const owner = byName.get(base);
        const normalizedName =
          owner && owner.companyId !== null && owner.companyId !== c.id
            ? `${base} ${(c.nseSymbol ?? String(c.id)).toLowerCase()}`
            : base;
        const values = {
          kind: "listed" as const,
          canonicalName: c.name,
          normalizedName,
          companyId: c.id,
          country: "IN",
          sector: c.industry ?? c.sector ?? null,
          groupKey: groupKeyFor(c.nseSymbol),
          updatedAt: new Date(),
        };
        const current =
          byCompany.get(c.id) ?? (owner && owner.companyId === null ? owner.id : null);
        if (current !== null) {
          await tx.update(counterparties).set(values).where(eq(counterparties.id, current));
          idOf.set(c.id, current);
        } else {
          const [inserted] = await tx
            .insert(counterparties)
            .values(values)
            .returning({ id: counterparties.id });
          if (!inserted) throw new Error(`counterparty insert failed for company ${c.id}`);
          idOf.set(c.id, inserted.id);
        }
        byName.set(normalizedName, {
          id: idOf.get(c.id) as number,
          companyId: c.id,
          normalizedName,
        });
      }
      throwIfAborted(signal);

      const aliases: AliasRow[] = [];
      const identifiers: Array<{ counterpartyId: number; scheme: string; value: string }> = [];
      for (const c of rows) {
        const counterpartyId = idOf.get(c.id) as number;
        for (const alias of aliasesFor(c.name, c.nseSymbol)) {
          aliases.push(phraseAlias(counterpartyId, alias, "registry"));
        }
        for (const symbol of symbolAliasesFor(c.nseSymbol)) {
          aliases.push(symbolAlias(counterpartyId, symbol, "registry"));
        }
        if (c.nseSymbol) identifiers.push({ counterpartyId, scheme: "nse", value: c.nseSymbol });
        if (c.isin) identifiers.push({ counterpartyId, scheme: "isin", value: c.isin });
        if (c.bseCode) identifiers.push({ counterpartyId, scheme: "bse", value: c.bseCode });
      }

      let curated = 0;
      for (const cp of CURATED_COUNTERPARTIES) {
        const counterpartyId = await upsertNamed(tx, cp.name, cp.kind, cp.country);
        curated++;
        for (const alias of cp.aliases) {
          aliases.push(phraseAlias(counterpartyId, alias, "curated"));
        }
        for (const symbol of cp.symbols) {
          aliases.push(symbolAlias(counterpartyId, symbol, "curated"));
        }
      }

      for (let i = 0; i < aliases.length; i += BATCH) {
        await tx
          .insert(counterpartyAliases)
          .values(aliases.slice(i, i + BATCH))
          .onConflictDoUpdate({
            target: [counterpartyAliases.counterpartyId, counterpartyAliases.normalizedAlias],
            set: {
              alias: sql`excluded.alias`,
              source: sql`excluded.source`,
              approved: sql`excluded.approved`,
              exactCase: sql`excluded.exact_case`,
            },
            setWhere: sql`${counterpartyAliases.source} in ('registry', 'curated', 'extracted')`,
          });
      }
      for (let i = 0; i < identifiers.length; i += BATCH) {
        await tx
          .insert(counterpartyIdentifiers)
          .values(identifiers.slice(i, i + BATCH))
          .onConflictDoUpdate({
            target: [counterpartyIdentifiers.scheme, counterpartyIdentifiers.value],
            set: { counterpartyId: sql`excluded.counterparty_id` },
          });
      }

      const memberships = rows.flatMap((c) => {
        const groupKey = groupKeyFor(c.nseSymbol);
        return groupKey ? [{ companyId: c.id, groupKey, source: "curated" }] : [];
      });
      await tx.delete(companyGroupMemberships).where(eq(companyGroupMemberships.source, "curated"));
      if (memberships.length) {
        await tx.insert(companyGroupMemberships).values(memberships).onConflictDoNothing();
      }

      return {
        listed: rows.length,
        curated,
        aliases: aliases.length,
        identifiers: identifiers.length,
        memberships: memberships.length,
      };
    },
    signal,
  );
}

function phraseAlias(counterpartyId: number, alias: string, source: AliasRow["source"]): AliasRow {
  return {
    counterpartyId,
    alias,
    normalizedAlias: normalizeCompanyName(alias),
    source,
    approved: true,
    exactCase: false,
  };
}

function symbolAlias(counterpartyId: number, symbol: string, source: AliasRow["source"]): AliasRow {
  return {
    counterpartyId,
    alias: symbol,
    normalizedAlias: symbol,
    source,
    approved: true,
    exactCase: true,
  };
}

async function upsertNamed(
  tx: Tx,
  name: string,
  kind: CounterpartyKind,
  country: string | null,
): Promise<number> {
  const normalizedName = normalizeCompanyName(name);
  const [row] = await tx
    .insert(counterparties)
    .values({ kind, canonicalName: name, normalizedName, country })
    .onConflictDoUpdate({
      target: counterparties.normalizedName,
      set: { updatedAt: new Date() },
    })
    .returning({ id: counterparties.id });
  if (!row) throw new Error(`counterparty upsert failed for ${name}`);
  return row.id;
}

export interface ResolvedCounterparty extends AliasEntry {
  created: boolean;
}

export async function resolveCounterparty(
  tx: Tx,
  matcher: AliasMatcher,
  name: string,
  kind: Exclude<CounterpartyKind, "listed" | "group">,
): Promise<ResolvedCounterparty | null> {
  const normalized = normalizeCompanyName(name);
  if (normalized.length < 4) return null;
  const known = matcher.phrases.get(normalized);
  if (known) return { ...known, created: false };
  const [existing] = await tx
    .select({
      id: counterparties.id,
      companyId: counterparties.companyId,
      name: counterparties.canonicalName,
      kind: counterparties.kind,
      groupKey: counterparties.groupKey,
    })
    .from(counterparties)
    .leftJoin(counterpartyAliases, eq(counterpartyAliases.counterpartyId, counterparties.id))
    .where(
      or(
        eq(counterparties.normalizedName, normalized),
        eq(counterpartyAliases.normalizedAlias, normalized),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      counterpartyId: existing.id,
      companyId: existing.companyId,
      name: existing.name,
      kind: existing.kind,
      phrases: [],
      symbols: [],
      groupKeys: existing.groupKey ? [existing.groupKey] : [],
      created: false,
    };
  }
  const [inserted] = await tx
    .insert(counterparties)
    .values({ kind, canonicalName: name, normalizedName: normalized, country: "IN" })
    .returning({ id: counterparties.id });
  if (!inserted) throw new Error(`counterparty insert failed for ${name}`);
  await tx
    .insert(counterpartyAliases)
    .values({
      counterpartyId: inserted.id,
      alias: name,
      normalizedAlias: normalized,
      source: "extracted",
      approved: false,
      exactCase: false,
    })
    .onConflictDoNothing();
  return {
    counterpartyId: inserted.id,
    companyId: null,
    name,
    kind,
    phrases: [],
    symbols: [],
    groupKeys: [],
    created: true,
  };
}

export async function loadCounterpartyMatcher(db: Pick<Db, "select">): Promise<AliasMatcher> {
  const [parties, aliases, groups, blocks] = await Promise.all([
    db
      .select({
        id: counterparties.id,
        companyId: counterparties.companyId,
        name: counterparties.canonicalName,
        kind: counterparties.kind,
        groupKey: counterparties.groupKey,
      })
      .from(counterparties),
    db
      .select({
        counterpartyId: counterpartyAliases.counterpartyId,
        alias: counterpartyAliases.alias,
        exactCase: counterpartyAliases.exactCase,
      })
      .from(counterpartyAliases)
      .where(
        or(
          eq(counterpartyAliases.approved, true),
          inArray(counterpartyAliases.source, ["registry", "curated"]),
        ),
      ),
    db
      .select({
        companyId: companyGroupMemberships.companyId,
        groupKey: companyGroupMemberships.groupKey,
      })
      .from(companyGroupMemberships)
      .where(
        or(
          isNull(companyGroupMemberships.validTo),
          sql`${companyGroupMemberships.validTo} >= current_date`,
        ),
      ),
    db
      .select({
        supplier: relationshipBlocks.supplierCounterpartyId,
        customer: relationshipBlocks.customerCounterpartyId,
      })
      .from(relationshipBlocks),
  ]);
  const groupsOf = new Map<number, string[]>();
  for (const g of groups)
    groupsOf.set(g.companyId, [...(groupsOf.get(g.companyId) ?? []), g.groupKey]);
  const phrasesOf = new Map<number, string[]>();
  const symbolsOf = new Map<number, string[]>();
  for (const a of aliases) {
    const into = a.exactCase ? symbolsOf : phrasesOf;
    into.set(a.counterpartyId, [...(into.get(a.counterpartyId) ?? []), a.alias]);
  }
  const entries: AliasEntry[] = parties.map((p) => ({
    counterpartyId: p.id,
    companyId: p.companyId,
    name: p.name,
    kind: p.kind,
    phrases: phrasesOf.get(p.id) ?? [],
    symbols: symbolsOf.get(p.id) ?? [],
    groupKeys: [
      ...new Set([
        ...(p.groupKey ? [p.groupKey] : []),
        ...(p.companyId === null ? [] : (groupsOf.get(p.companyId) ?? [])),
      ]),
    ],
  }));
  return buildAliasMatcher(
    entries,
    blocks.map((b) => [b.supplier, b.customer] as const),
  );
}
