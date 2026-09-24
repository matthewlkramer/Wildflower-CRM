import { useMemo } from "react";
import { Link } from "wouter";
import type {
  TopPriorityAffiliate,
  TopPriorityGiftOrPledgeSummary,
  TopPriorityOpenAsk,
  TopPriorityOrganization,
  TopPriorityPerson,
} from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";
import { PriorityStar } from "@/components/priority-star";
import { useUserNameMap } from "@/components/user-picker";
import { ANONYMOUS_LABEL } from "@/lib/visibility";
import { personDisplayName } from "@/lib/person";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import { Star } from "lucide-react";

function FunderNameCell({ funder }: { funder: TopPriorityOrganization }) {
  return (
    <div className="flex items-center gap-1.5">
      <PriorityStar priority="top" size="sm" />
      <Link
        href={`/organizations/${funder.id}`}
        className="font-medium text-primary hover:underline"
      >
        {funder.name}
      </Link>
    </div>
  );
}

function PersonNameCell({ person }: { person: TopPriorityPerson }) {
  const label =
    person.anonymous && !person.fullName && !person.firstName
      ? ANONYMOUS_LABEL
      : personDisplayName({
          fullName: person.fullName,
          firstName: person.firstName,
          lastName: person.lastName,
          nickname: null,
          id: person.id,
        });
  return (
    <div className="flex items-center gap-1.5">
      <PriorityStar priority="top" size="sm" />
      <Link
        href={`/individuals/${person.id}`}
        className="font-medium text-primary hover:underline"
      >
        {label}
      </Link>
    </div>
  );
}

function AffiliatedPeopleCell({ people }: { people: TopPriorityAffiliate[] }) {
  if (!people.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-x-1">
      {people.map((person, index) => (
        <span key={person.personId}>
          <Link
            href={`/individuals/${person.personId}`}
            className="text-primary hover:underline"
          >
            {person.personName}
          </Link>
          {index < people.length - 1 ? (
            <span className="text-muted-foreground">, </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function OpenAsksCell({ asks }: { asks: TopPriorityOpenAsk[] }) {
  if (!asks.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-2 py-1">
      {asks.map((ask) => (
        <div key={ask.opportunityId}>
          <Link
            href={`/opportunities/${ask.opportunityId}`}
            className="font-medium text-primary hover:underline"
          >
            {ask.opportunityName}
          </Link>
          <div className="text-xs text-muted-foreground">
            {ask.askAmount ? formatCurrency(ask.askAmount) : "Amount not set"}
            {" · "}
            {ask.stage ? formatEnum(ask.stage) : "Stage not set"}
            {" · "}
            {ask.projectedCloseDate
              ? `Closes ${formatDateShort(ask.projectedCloseDate)}`
              : "No projected close"}
          </div>
        </div>
      ))}
    </div>
  );
}

function GiftOrPledgeCell({
  summary,
}: {
  summary: TopPriorityGiftOrPledgeSummary | null | undefined;
}) {
  if (!summary) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="text-sm tabular-nums">
      <div className="font-medium">
        {summary.kind === "gift" ? "Gift" : "Pledge"}{" "}
        {formatCurrency(summary.amount)}
      </div>
      <div className="text-xs text-muted-foreground">
        {summary.date ? formatDateShort(summary.date) : "Date not set"}
        {summary.kind === "pledge" && summary.paymentStatus
          ? ` · ${formatEnum(summary.paymentStatus)}`
          : ""}
      </div>
    </div>
  );
}

function FundersTable({
  funders,
  loading,
  tableId,
}: {
  funders: TopPriorityOrganization[];
  loading: boolean;
  tableId: string;
}) {
  const tableState = useTableState(tableId, { key: "name" });
  const userNames = useUserNameMap();
  const sorted = useMemo(
    () =>
      sortRows(
        funders,
        {
          name: (funder) => funder.name,
          owner: (funder) =>
            funder.ownerUserId
              ? (userNames.get(funder.ownerUserId) ?? funder.ownerUserId)
              : null,
          openTaskCount: (funder) => funder.openTaskCount,
          lastGiftDate: (funder) => funder.lastGiftDate,
          lastGiftAmount: (funder) =>
            funder.lastGiftAmount != null
              ? Number(funder.lastGiftAmount)
              : null,
        },
        tableState.sort,
      ),
    [funders, tableState.sort, userNames],
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTH colKey="name" {...tableState} className="pl-6">
            Funder
          </SortableTH>
          <SortableTH colKey="owner" {...tableState} className="w-36">
            Owner
          </SortableTH>
          <TableHead>Open opportunities</TableHead>
          <SortableTH
            colKey="openTaskCount"
            {...tableState}
            align="right"
            className="w-28"
          >
            Open tasks
          </SortableTH>
          <TableHead className="w-40">Affiliated people</TableHead>
          <TableHead className="w-40 pr-6">Gift or pledge</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <SkeletonRows cols={6} />
        ) : funders.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={6}
              className="py-8 pl-6 text-center text-muted-foreground"
            >
              No top-priority funders in this view
            </TableCell>
          </TableRow>
        ) : (
          sorted.map((funder) => (
            <TableRow key={funder.id}>
              <TableCell className="pl-6">
                <FunderNameCell funder={funder} />
              </TableCell>
              <TableCell className="text-sm">
                {funder.ownerUserId ? (
                  (userNames.get(funder.ownerUserId) ?? funder.ownerUserId)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <OpenAsksCell asks={funder.openAsks ?? []} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {funder.openTaskCount > 0 ? (
                  <span className="font-medium">{funder.openTaskCount}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <AffiliatedPeopleCell people={funder.affiliatedPeople ?? []} />
              </TableCell>
              <TableCell className="pr-6">
                <GiftOrPledgeCell summary={funder.giftOrPledgeSummary} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function IndividualsTable({
  individuals,
  loading,
  tableId,
}: {
  individuals: TopPriorityPerson[];
  loading: boolean;
  tableId: string;
}) {
  const tableState = useTableState(tableId, { key: "name" });
  const userNames = useUserNameMap();
  const sorted = useMemo(
    () =>
      sortRows(
        individuals,
        {
          name: (person) =>
            person.fullName ||
            [person.firstName, person.lastName].filter(Boolean).join(" ") ||
            person.id,
          owner: (person) =>
            person.ownerUserId
              ? (userNames.get(person.ownerUserId) ?? person.ownerUserId)
              : null,
          openTaskCount: (person) => person.openTaskCount,
          lastGiftDate: (person) => person.lastGiftDate,
          lastGiftAmount: (person) =>
            person.lastGiftAmount != null
              ? Number(person.lastGiftAmount)
              : null,
        },
        tableState.sort,
      ),
    [individuals, tableState.sort, userNames],
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTH colKey="name" {...tableState} className="pl-6">
            Individual
          </SortableTH>
          <SortableTH colKey="owner" {...tableState} className="w-36">
            Owner
          </SortableTH>
          <TableHead>Open opportunities</TableHead>
          <SortableTH
            colKey="openTaskCount"
            {...tableState}
            align="right"
            className="w-28"
          >
            Open tasks
          </SortableTH>
          <TableHead className="w-40 pr-6">Gift or pledge</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <SkeletonRows cols={5} />
        ) : individuals.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={5}
              className="py-8 pl-6 text-center text-muted-foreground"
            >
              No top-priority individuals in this view
            </TableCell>
          </TableRow>
        ) : (
          sorted.map((person) => (
            <TableRow key={person.id}>
              <TableCell className="pl-6">
                <PersonNameCell person={person} />
              </TableCell>
              <TableCell className="text-sm">
                {person.ownerUserId ? (
                  (userNames.get(person.ownerUserId) ?? person.ownerUserId)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <OpenAsksCell asks={person.openAsks ?? []} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {person.openTaskCount > 0 ? (
                  <span className="font-medium">{person.openTaskCount}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="pr-6">
                <GiftOrPledgeCell summary={person.giftOrPledgeSummary} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export function TopPrioritiesTables({
  funders,
  individuals,
  loading,
  tableIdPrefix = "top-priority",
}: {
  funders: TopPriorityOrganization[];
  individuals: TopPriorityPerson[];
  loading: boolean;
  tableIdPrefix?: string;
}) {
  return (
    <div className="divide-y" data-testid="top-priorities-tables">
      <section aria-labelledby={`${tableIdPrefix}-funders-heading`}>
        <div className="flex items-center gap-2 px-6 py-3">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
          <h3
            id={`${tableIdPrefix}-funders-heading`}
            className="text-sm font-semibold"
          >
            Top-priority funders
          </h3>
          {!loading ? (
            <span className="text-sm text-muted-foreground">
              ({funders.length})
            </span>
          ) : null}
        </div>
        <FundersTable
          funders={funders}
          loading={loading}
          tableId={`${tableIdPrefix}-funders`}
        />
      </section>
      <section aria-labelledby={`${tableIdPrefix}-individuals-heading`}>
        <div className="flex items-center gap-2 px-6 py-3">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
          <h3
            id={`${tableIdPrefix}-individuals-heading`}
            className="text-sm font-semibold"
          >
            Top-priority individuals
          </h3>
          {!loading ? (
            <span className="text-sm text-muted-foreground">
              ({individuals.length})
            </span>
          ) : null}
        </div>
        <IndividualsTable
          individuals={individuals}
          loading={loading}
          tableId={`${tableIdPrefix}-individuals`}
        />
      </section>
    </div>
  );
}
