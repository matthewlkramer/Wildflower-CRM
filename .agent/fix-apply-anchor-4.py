from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
old = """    '''{candidatePaymentUnits.isLoading ? <p className="text-sm text-muted-foreground">Searching unclaimed payment units…</p> : candidatePaymentUnits.isError ? <p className="text-sm text-destructive">Could not load candidate payment units.</p> : candidatePaymentUnits.data?.data.length ? candidatePaymentUnits.data.data.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="w-full rounded-md border p-3 text-left hover:bg-muted"
                    onClick={() => void handleAttachPaymentUnit(candidate)}
                    disabled={addBankComponent.isPending}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{candidate.sourceLabel}</span>
                      <span className="tabular-nums">{formatCurrency(candidate.amount)}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{candidate.kind.replaceAll("_", " ")} · {candidate.receivedDate ?? "Undated"} · {candidate.id}</div>
                  </button>
                )) : <p className="text-sm text-muted-foreground">No unclaimed payment units near this remainder.</p>}''',"""
new = """    '''{candidatePaymentUnits.isLoading ? <p className="text-sm text-muted-foreground">Searching unclaimed payment units…</p> : candidatePaymentUnits.isError ? <p className="text-sm text-destructive">Could not load candidate payment units.</p> : candidatePaymentUnits.data?.data.length ? candidatePaymentUnits.data.data.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                    disabled={busy}
                    onClick={() => void handleAttachPaymentUnit(candidate)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{candidate.sourceLabel}</span>
                      <span className="block text-xs text-muted-foreground">{candidate.kind.replace("_", " ")} · {candidate.receivedDate ?? "undated"} · {candidate.id}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatCurrency(candidate.amount)} {candidate.currency}</span>
                  </button>
                )) : <p className="text-sm text-muted-foreground">No unclaimed payment units near this remainder.</p>}''',"""
if old not in text:
    raise SystemExit("candidate dialog patch source not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
