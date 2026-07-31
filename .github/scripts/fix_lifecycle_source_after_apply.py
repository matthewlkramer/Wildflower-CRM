from pathlib import Path
import re


def replace_required(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"Expected {expected} matches in {path} for {old!r}; found {count}")
    p.write_text(text.replace(old, new))


stage_path = "artifacts/api-server/src/lib/pledgeStage.ts"
for name in (
    "commitmentPath",
    "verbalCommitmentAt",
    "pledgeCommittedAt",
    "actualCompletionDate",
):
    replace_required(
        stage_path,
        f"let {name} = input.{name};",
        f"let {name} = input.{name} ?? null;",
    )

# writtenPledge is a temporary read-compatibility mirror, not a required
# lifecycle input. Existing callers that do not carry the legacy field should
# derive safely from the new commitment fields.
replace_required(
    stage_path,
    "  writtenPledge: boolean | null;",
    "  writtenPledge?: boolean | null;",
)

route_path = Path("artifacts/api-server/src/routes/opportunitiesAndPledges.ts")
route = route_path.read_text()
# writtenPledge is no longer part of generated request contracts or the bulk
# field vocabulary. Remove the old whitelist item and any create-body read.
route, removed_whitelist = re.subn(
    r'(?m)^\s*"writtenPledge",\n',
    "",
    route,
)
if removed_whitelist < 1:
    raise RuntimeError("Expected at least one writtenPledge bulk-field entry")
route, removed_body = re.subn(
    r'(?m)^\s*writtenPledge:\s*body\.writtenPledge\s*\?\?\s*false,\n',
    "",
    route,
)
if removed_body < 1:
    # Current create code may spread the value rather than assign it directly.
    route, removed_body = re.subn(
        r'(?m)^\s*\.\.\.\(body\.writtenPledge[^\n]*\),\n',
        "",
        route,
    )
if removed_body < 1:
    # Last-resort exact property read: the lifecycle request schema no longer
    # exposes it, so delete the containing single line only.
    lines = route.splitlines(keepends=True)
    kept = [line for line in lines if "body.writtenPledge" not in line]
    removed_body = len(lines) - len(kept)
    route = "".join(kept)
if removed_body < 1:
    raise RuntimeError("Expected a legacy body.writtenPledge create reference")
route_path.write_text(route)

# The new lifecycle values are part of the canonical opportunity response.
# OpportunityOrPledgeDetail inherits this schema through allOf, so placing the
# fields here keeps list and detail contracts aligned and lets generated web
# types expose them without a local type cast.
openapi_path = Path("lib/api-spec/openapi.yaml")
openapi = openapi_path.read_text()
opp_start_marker = "    OpportunityOrPledge:\n"
opp_detail_marker = "    OpportunityOrPledgeDetail:\n"
opp_start = openapi.find(opp_start_marker)
opp_end = openapi.find(opp_detail_marker, opp_start)
if opp_start < 0 or opp_end < 0:
    raise RuntimeError("Could not isolate OpportunityOrPledge OpenAPI schema")
opp_block = openapi[opp_start:opp_end]

if "        commitmentPath:" not in opp_block:
    stage_match = re.search(
        r'(?m)^        stage:\s+\{ allOf: \[ \{ \$ref: "#/components/schemas/OpportunityStage" \} \], nullable: true \}\n',
        opp_block,
    )
    if not stage_match:
        raise RuntimeError("Could not locate OpportunityOrPledge.stage property")
    lifecycle_properties = (
        '        commitmentPath:           { allOf: [ { $ref: "#/components/schemas/OpportunityCommitmentPath" } ], nullable: true, readOnly: true, description: "The positive outcome the donor verbally confirmed; not itself an actual pledge or gift." }\n'
        '        verbalCommitmentAt:       { type: string, format: date, nullable: true, readOnly: true }\n'
        '        pledgeCommittedAt:        { type: string, format: date, nullable: true, readOnly: true, description: "Authoritative date this opportunity became a real pledge. Null for verbally confirmed gifts awaiting money." }\n'
        '        outcomeType:              { allOf: [ { $ref: "#/components/schemas/OpportunityOutcomeType" } ], nullable: true, readOnly: true, description: "Actual positive outcome, derived from pledge finalization or received money." }\n'
    )
    opp_block = (
        opp_block[: stage_match.end()]
        + lifecycle_properties
        + opp_block[stage_match.end() :]
    )

# Keep writtenPledge only as a deprecated read-only compatibility mirror.
written_pattern = re.compile(
    r'(?m)^        writtenPledge:\s+\{ type: boolean(?:, [^}]*)? \}\n'
)
written_matches = list(written_pattern.finditer(opp_block))
if len(written_matches) != 1:
    raise RuntimeError(
        f"Expected one OpportunityOrPledge writtenPledge property; found {len(written_matches)}"
    )
read_only_written = (
    '        writtenPledge:              { type: boolean, readOnly: true, deprecated: true, description: "Compatibility mirror of pledgeCommittedAt != null; never write directly." }\n'
)
match = written_matches[0]
opp_block = opp_block[: match.start()] + read_only_written + opp_block[match.end() :]
openapi = openapi[:opp_start] + opp_block + openapi[opp_end:]
openapi_path.write_text(openapi)

# Once money arrives, the linked opportunity should close as a direct gift or
# record a payment against an already-finalized pledge. The old follow-up that
# offered to turn the record into a written pledge after receiving money was
# precisely the ambiguity this lifecycle revision removes.
gift_path = Path("artifacts/wildflower-crm/src/components/gift-form-dialog.tsx")
gift = gift_path.read_text()

follow_label = "   Post-creation follow-up prompt"
main_label = "   Main dialog"
follow_label_at = gift.find(follow_label)
main_label_at = gift.find(main_label, follow_label_at)
if follow_label_at < 0 or main_label_at < 0:
    raise RuntimeError("Could not isolate obsolete gift follow-up component")
follow_start = gift.rfind("/*", 0, follow_label_at)
main_start = gift.rfind("/*", 0, main_label_at)
if follow_start < 0 or main_start < 0 or main_start <= follow_start:
    raise RuntimeError("Could not identify gift follow-up component boundaries")
gift = gift[:follow_start] + gift[main_start:]

follow_state = '''  // Follow-up state — set after creation when the linked opp was "open"
  const [followUpOpp, setFollowUpOpp] = useState<{
    id: string;
    name: string | null;
  } | null>(null);
  const [pendingNavGiftId, setPendingNavGiftId] = useState<string | null>(null);

'''
if gift.count(follow_state) != 1:
    raise RuntimeError("Could not locate obsolete gift follow-up state")
gift = gift.replace(follow_state, "", 1)

old_success = '''        const giftId = created?.id ?? null;
        // If the linked opportunity was still "open", prompt the user to
        // advance its stage before navigating to the new gift.
        if (giftId && linkedOpp && linkedOpp.status === "open") {
          setOpen(false);
          const oppSnap = { id: linkedOpp.id, name: linkedOpp.name ?? null };
          resetForm();
          setPendingNavGiftId(giftId);
          setFollowUpOpp(oppSnap);
        } else {
          setOpen(false);
          resetForm();
          if (giftId) navigate(`/gifts/${giftId}`);
        }
'''
new_success = '''        const giftId = created?.id ?? null;
        setOpen(false);
        resetForm();
        if (giftId) navigate(`/gifts/${giftId}`);
'''
if gift.count(old_success) != 1:
    raise RuntimeError("Could not locate obsolete post-gift pledge prompt logic")
gift = gift.replace(old_success, new_success, 1)

old_render = '''      {/* Follow-up prompt rendered outside the main dialog so both can coexist */}
      {followUpOpp && pendingNavGiftId ? (
        <OppFollowUpDialog
          opp={followUpOpp}
          onDone={() => {
            const giftId = pendingNavGiftId;
            setFollowUpOpp(null);
            setPendingNavGiftId(null);
            if (giftId) navigate(`/gifts/${giftId}`);
          }}
        />
      ) : null}

'''
if gift.count(old_render) != 1:
    raise RuntimeError("Could not locate obsolete gift follow-up rendering")
gift = gift.replace(old_render, "", 1)

# Remove imports used only by the deleted follow-up component.
for import_line, symbol in (
    ("  useUpdateOpportunityOrPledge,\n", "useUpdateOpportunityOrPledge"),
    (
        "  getListOpportunitiesAndPledgesQueryKey,\n",
        "getListOpportunitiesAndPledgesQueryKey",
    ),
):
    if gift.count(symbol) != 1 or import_line not in gift:
        raise RuntimeError(f"Expected {symbol} to remain only as an import")
    gift = gift.replace(import_line, "", 1)

for obsolete_symbol in (
    "OppFollowUpDialog",
    "followUpOpp",
    "pendingNavGiftId",
    "writtenPledge: true",
):
    if obsolete_symbol in gift:
        raise RuntimeError(f"Obsolete gift lifecycle symbol remains: {obsolete_symbol}")

gift_path.write_text(gift)
