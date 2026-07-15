import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Search, Filter, CheckCircle2, AlertCircle,
  Ban, Link as LinkIcon,
  ChevronRight, ChevronDown,
  Plus, Copy, FileCheck, Layers
} from "lucide-react";

// PEER MODEL — there is NO "unit" object. Only three kinds of records exist:
// WHO & WHY (CRM), TRANSACTION (proof), ACCOUNTING (QB) — plus LINKS between
// them. A worklist row is simply a CLUSTER of linked records; a stray record
// is a cluster of one. The former side lanes become lenses (filters) over the
// same list. Exclusion is a property of a record, not of a container.
// LINKAGE = does a linked record of that kind exist; ADEQUACY = is that
// record itself complete. Both stay per-record.

type RecordChipData = {
  amount: number;
  date: string;
  ref: string;        // the record's own identity
  adequate: boolean;
  detail?: string;    // supporting detail when adequate
  problem?: string;   // inadequacy reason, shown INSIDE the chip
  excluded?: string;  // exclusion reason — lives on the record itself
};

type ClusterStatus = "complete" | "partial" | "unlinked" | "excluded";

interface ClusterRow {
  id: string;
  status: ClusterStatus;
  whoWhy?: RecordChipData;
  transaction?: RecordChipData;
  accounting?: RecordChipData;
  // A check: ONE QB record participates in the cluster in BOTH the
  // transaction and accounting roles, each role with its own adequacy.
  qbSpan?: {
    amount: number;
    date: string;
    ref: string;
    txn: { adequate: boolean; note: string };
    acct: { adequate: boolean; note: string };
  };
  isExpanded?: boolean;
}

const CLUSTERS: ClusterRow[] = [
  {
    id: "cl-1",
    status: "partial",
    whoWhy: {
      amount: 150000, date: "Oct 01, 2026",
      ref: "Meadow Fund Commitment",
      adequate: true, detail: "Grant letter on file"
    },
    transaction: {
      amount: 150000, date: "Oct 15, 2026",
      ref: "Wire TR-991",
      adequate: false, problem: "Missing originating bank confirmation"
    },
    accounting: {
      amount: 150000, date: "Oct 15, 2026",
      ref: "DEP-8821 · QB Deposit",
      adequate: true, detail: "4010 Grants · Class: National"
    },
    isExpanded: true // The exemplar
  },
  {
    id: "cl-2",
    status: "partial",
    whoWhy: {
      amount: 25000, date: "Oct 02, 2026",
      ref: "Third Coast Foundation",
      adequate: false, problem: "Missing grant letter"
    },
    qbSpan: {
      amount: 25000, date: "Oct 12, 2026",
      ref: "CHK-8812 · QB Check",
      txn: { adequate: true, note: "Check image on file" },
      acct: { adequate: false, note: "Needs account + class coding" }
    }
  },
  {
    id: "cl-3",
    status: "partial",
    transaction: {
      amount: 824.10, date: "Oct 10, 2026",
      ref: "po_1Qxyz98 · Stripe Payout",
      adequate: true, detail: "4 charges itemized"
    },
    accounting: {
      amount: 824.10, date: "Oct 10, 2026",
      ref: "DEP-3410 · QB Deposit",
      adequate: false, problem: "Missing class code"
    }
  },
  {
    id: "cl-4",
    status: "unlinked",
    transaction: {
      amount: 250, date: "Oct 18, 2026",
      ref: "ch_3Mxyz · Stripe Charge",
      adequate: true, detail: "Card receipt attached"
    }
  },
  {
    id: "cl-5",
    status: "unlinked",
    transaction: {
      amount: 5000, date: "Oct 19, 2026",
      ref: "CHK-1002 · Check image",
      adequate: true, detail: "Uploaded scan"
    }
  },
  {
    id: "cl-6",
    status: "unlinked",
    whoWhy: {
      amount: 75000, date: "Oct 16, 2026",
      ref: "Prairie Sky Fund",
      adequate: true, detail: "Pledge — expected this month"
    }
  },
  {
    id: "cl-7",
    status: "unlinked",
    whoWhy: {
      amount: 10000, date: "Oct 17, 2026",
      ref: "Hollyhock Family Fund",
      adequate: true, detail: "Annual gift"
    }
  },
  {
    id: "cl-8",
    status: "excluded",
    accounting: {
      amount: 45, date: "Oct 05, 2026",
      ref: "DEP-3388 · QB Deposit",
      adequate: true, detail: "6120 Bank fees",
      excluded: "Non-donation: Operating revenue"
    }
  }
];

const LENSES = [
  { label: "All clusters", count: 14, active: true },
  { label: "Missing WHO & WHY", count: 5, active: false },
  { label: "Missing transaction", count: 4, active: false },
  { label: "Missing accounting", count: 6, active: false },
  { label: "Adequacy gaps", count: 4, active: false },
  { label: "Excluded records", count: 1, active: false },
];

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

// A RECORD chip — carries its own amount, date, identity, and adequacy.
// There is no container to borrow identity from.
const RecordChip = ({ r }: { r: RecordChipData }) => {
  const tone = r.excluded
    ? { border: "border-slate-300", bg: "bg-slate-50", text: "text-slate-700", sub: "text-slate-500" }
    : r.adequate
    ? { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-900", sub: "text-emerald-700/80" }
    : { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-900", sub: "text-amber-700" };
  return (
    <div className={`p-2 w-full rounded border ${tone.border} ${tone.bg}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${tone.text}`}>{formatCurrency(r.amount)}</span>
        <span className="text-[9px] font-mono text-slate-400">{r.date}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        {r.excluded
          ? <Ban className="w-3 h-3 text-slate-500 shrink-0" />
          : r.adequate
          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          : <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
        <span className={`text-xs font-medium ${tone.text}`}>{r.ref}</span>
      </div>
      {r.detail && <div className={`text-[10px] mt-0.5 pl-5 leading-tight ${tone.sub}`}>{r.detail}</div>}
      {r.problem && <div className="text-[10px] mt-0.5 pl-5 leading-tight font-medium text-amber-700">{r.problem}</div>}
      {r.excluded && (
        <div className="mt-1.5 inline-flex items-center gap-1 bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
          <Ban className="w-3 h-3" /> {r.excluded}
        </div>
      )}
    </div>
  );
};

// Absence isn't an object either — just a quiet affordance to link one in.
const LinkGhost = ({ label }: { label: string }) => (
  <button className="flex items-center justify-center gap-1 min-h-12 w-full rounded border border-dashed border-slate-200 bg-slate-50/30 text-slate-300 hover:text-slate-500 hover:border-slate-300 transition-colors">
    <Plus className="w-3 h-3" />
    <span className="text-[10px] font-medium uppercase tracking-wider">Link {label}</span>
  </button>
);

// A check: ONE QB record filling BOTH the transaction and accounting roles.
const QbSpanChip = ({ span }: { span: NonNullable<ClusterRow["qbSpan"]> }) => (
  <div className="p-2 w-full rounded border border-slate-300 bg-white">
    <div className="flex items-center gap-1.5 mb-1.5">
      <FileCheck className="w-3.5 h-3.5 text-slate-600 shrink-0" />
      <span className="text-xs font-semibold text-slate-800">{formatCurrency(span.amount)} · {span.ref}</span>
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider ml-auto">One record, two roles</span>
    </div>
    <div className="grid grid-cols-2 gap-1.5">
      <div className={`rounded border px-1.5 py-1 ${span.txn.adequate ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Transaction</div>
        <div className={`text-[10px] leading-tight font-medium flex items-center gap-1 mt-0.5 ${span.txn.adequate ? 'text-emerald-700' : 'text-amber-700'}`}>
          {span.txn.adequate ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <AlertCircle className="w-3 h-3 shrink-0" />}
          {span.txn.note}
        </div>
      </div>
      <div className={`rounded border px-1.5 py-1 ${span.acct.adequate ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Accounting</div>
        <div className={`text-[10px] leading-tight font-medium flex items-center gap-1 mt-0.5 ${span.acct.adequate ? 'text-emerald-700' : 'text-amber-700'}`}>
          {span.acct.adequate ? <CheckCircle2 className="w-3 h-3 shrink-0" /> : <AlertCircle className="w-3 h-3 shrink-0" />}
          {span.acct.note}
        </div>
      </div>
    </div>
  </div>
);

const StatusBadge = ({ status }: { status: ClusterStatus }) => {
  const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider";
  switch (status) {
    case "complete": return <span className={`${base} bg-emerald-100 text-emerald-800`}>Reconciled</span>;
    case "partial": return <span className={`${base} bg-blue-100 text-blue-800`}>Partial</span>;
    case "unlinked": return <span className={`${base} bg-amber-100 text-amber-800`}>Unlinked</span>;
    case "excluded": return <span className={`${base} bg-slate-200 text-slate-600`}>Excluded</span>;
  }
};

const facetCount = (c: ClusterRow) => {
  let n = 0;
  if (c.whoWhy) n++;
  if (c.transaction) n++;
  if (c.accounting) n++;
  if (c.qbSpan) n += 2;
  return n;
};

export function UnbrokenQueue() {
  return (
    <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      <header className="px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex justify-between items-center shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center shadow-sm">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight text-slate-900">Finance Reconciliation</h1>
            <p className="text-xs text-slate-500 font-medium">Main Worklist</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* MAIN WORKLIST */}
        <div className="flex-1 flex flex-col min-w-0 bg-white">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <div>
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                Linked Records <Badge variant="secondary" className="bg-slate-200 text-slate-700">14 clusters</Badge>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5 max-w-xl">
                No container object — WHO &amp; WHY, transaction, and accounting records are peers, and a row is
                whatever records are linked together. A stray record is just a cluster of one.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-64">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input placeholder="Search any record..." className="pl-8 h-8 text-xs bg-white" />
              </div>
              <Button variant="outline" size="sm" className="h-8 text-xs"><Filter className="w-3.5 h-3.5 mr-1.5"/> Filter</Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="border border-slate-200 rounded-lg shadow-sm overflow-hidden">
              <Table>
                <TableHeader className="bg-slate-50 border-b border-slate-200">
                  <TableRow className="hover:bg-slate-50">
                    <TableHead className="w-[28px]"></TableHead>
                    <TableHead className="w-[240px] text-xs font-semibold text-slate-600">WHO &amp; WHY (CRM)</TableHead>
                    <TableHead className="w-[240px] text-xs font-semibold text-slate-600">TRANSACTION (Proof)</TableHead>
                    <TableHead className="w-[240px] text-xs font-semibold text-slate-600">ACCOUNTING (QB)</TableHead>
                    <TableHead className="text-right text-xs font-semibold text-slate-600">Cluster</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CLUSTERS.map((c) => (
                    <React.Fragment key={c.id}>
                      <TableRow className={`group ${c.status === 'excluded' ? 'opacity-60 bg-slate-50/50' : 'hover:bg-slate-50'} ${c.isExpanded ? 'bg-slate-50' : ''}`}>
                        <TableCell className="align-top py-3 pr-0">
                          {c.isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400 mt-3" /> : <ChevronRight className="w-4 h-4 text-slate-400 mt-3" />}
                        </TableCell>
                        <TableCell className="align-top py-3">
                          {c.whoWhy ? <RecordChip r={c.whoWhy} /> : <LinkGhost label="who & why" />}
                        </TableCell>
                        {c.qbSpan ? (
                          <TableCell colSpan={2} className="align-top py-3"><QbSpanChip span={c.qbSpan} /></TableCell>
                        ) : (
                          <>
                            <TableCell className="align-top py-3">
                              {c.transaction ? <RecordChip r={c.transaction} /> : <LinkGhost label="transaction" />}
                            </TableCell>
                            <TableCell className="align-top py-3">
                              {c.accounting ? <RecordChip r={c.accounting} /> : <LinkGhost label="accounting" />}
                            </TableCell>
                          </>
                        )}
                        <TableCell className="align-top py-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <StatusBadge status={c.status} />
                            <span className="text-[9px] text-slate-400 font-medium">{facetCount(c)} of 3 facets</span>
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* Expanded Exemplar Record */}
                      {c.isExpanded && (
                        <TableRow className="bg-slate-50/50 border-b border-slate-200 hover:bg-slate-50/50">
                          <TableCell colSpan={5} className="p-0 border-t border-slate-200/60">
                            <div className="p-6 pl-10">
                              <div className="bg-white border border-emerald-100 rounded-lg shadow-sm p-5 max-w-4xl">
                                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-slate-100">
                                  <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 uppercase tracking-wider text-[10px] font-bold rounded">Adequate WHO &amp; WHY Shape</Badge>
                                  <span className="text-sm font-semibold text-slate-800">Commitment: Meadow Fund 2026-2027</span>
                                </div>

                                <div className="grid grid-cols-4 gap-6 mb-6">
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Total Commitment</div>
                                    <div className="text-xl font-semibold text-slate-900">{formatCurrency(150000)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Schedule</div>
                                    <div className="text-sm font-medium text-slate-700">4 payments over 2 years</div>
                                  </div>
                                  <div className="col-span-2">
                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Documentation</div>
                                    <div className="text-sm font-medium text-blue-600 flex items-center gap-1.5"><FileCheck className="w-3.5 h-3.5" /> grant_agreement_signed.pdf</div>
                                  </div>
                                </div>

                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Allocations (3 Purposes)</div>
                                <div className="border border-slate-200 rounded-md overflow-hidden">
                                  <Table>
                                    <TableHeader className="bg-slate-50">
                                      <TableRow>
                                        <TableHead className="text-xs h-8">Amount</TableHead>
                                        <TableHead className="text-xs h-8">Purpose / Restriction</TableHead>
                                        <TableHead className="text-xs h-8">Fiscal Year</TableHead>
                                        <TableHead className="text-xs h-8">Region</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">General Operating Support</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2026</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">Technology Initiative (Restricted)</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2026</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                      <TableRow>
                                        <TableCell className="py-2 text-sm font-medium">{formatCurrency(50000)}</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">General Operating Support</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">FY 2027</TableCell>
                                        <TableCell className="py-2 text-sm text-slate-600">National</TableCell>
                                      </TableRow>
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        {/* SIDEBAR: LENSES + LINKING */}
        <div className="w-[340px] border-l border-slate-200 bg-slate-50 flex flex-col shrink-0 overflow-y-auto">

          {/* Lenses — the former stray lanes are now just filters over the same list */}
          <div className="p-4 border-b border-slate-200">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-slate-200 text-slate-700 flex items-center justify-center">
                <Filter className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-800">Lenses</h3>
            </div>
            <div className="text-xs text-slate-500 mb-3 leading-relaxed">
              "Stray" isn't a separate place anymore — the old side lanes are just views of the same list.
            </div>
            <div className="space-y-1">
              {LENSES.map(l => (
                <button
                  key={l.label}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                    l.active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <span>{l.label}</span>
                  <span className={`text-[10px] font-mono ${l.active ? 'text-slate-300' : 'text-slate-400'}`}>{l.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Linking = dragging rows together */}
          <div className="p-4 border-b border-slate-200">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-blue-100 text-blue-700 flex items-center justify-center">
                <LinkIcon className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-800">Linking</h3>
            </div>
            <div className="text-xs text-slate-500 mb-3 leading-relaxed">
              Drag any row onto another to combine their records into one cluster. Drop choices depend on what's being joined:
            </div>
            <div className="bg-white rounded-md border border-slate-200 shadow-sm p-2">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1">Cross-facet drop</div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 rounded bg-slate-50">
                <LinkIcon className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>Link as the same money</span>
              </div>
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1 mt-1.5">WHO &amp; WHY onto WHO &amp; WHY</div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 rounded bg-slate-50">
                  <Layers className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  <span>Group as allocations of one commitment</span>
                </div>
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 rounded bg-slate-50">
                  <Copy className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>Mark as double entry (Merge/Archive)</span>
                </div>
              </div>
            </div>
          </div>

          {/* Recently paired: cluster stays one row until delinked */}
          <div className="p-4 bg-white border-t border-slate-200 mt-auto">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-blue-100 text-blue-700 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-semibold text-slate-800">Recently paired</h3>
            </div>
            <div className="text-xs text-slate-500 mb-3 leading-relaxed">
              Linked records stay one cluster until explicitly delinked — searching for either record finds the whole cluster.
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50/40 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-sm text-slate-900">{formatCurrency(20000)} • Third Coast Foundation</span>
                <button className="text-[10px] font-medium text-slate-400 hover:text-slate-600 uppercase tracking-wider">Delink</button>
              </div>
              <div className="flex items-stretch gap-1.5">
                <div className="flex-1 rounded border border-emerald-200 bg-white px-2 py-1.5">
                  <div className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider">Who &amp; Why</div>
                  <div className="text-[11px] text-slate-700">Capacity grant · 2 allocations</div>
                </div>
                <div className="flex items-center text-blue-400">
                  <LinkIcon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 rounded border border-slate-200 bg-white px-2 py-1.5">
                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Transaction</div>
                  <div className="text-[11px] text-slate-700 font-mono">Check #2051 · Oct 20</div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
