from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
old = """page = replace_once(
    page,
    '''type UnlinkOption = {''',
    '''type CandidatePaymentUnitWithClaim = DepositCandidatePaymentUnit & {
  claimed?: boolean;
  claimedComponentId?: string | null;
  claimedBankDepositId?: string | null;
  claimedDepositDate?: string | null;
  claimedDepositAmount?: string | null;
  claimedDepositMemo?: string | null;
  claimedByCurrentDeposit?: boolean;
};

type UnlinkOption = {''',
    "candidate claim type",
)"""
new = """page = replace_once(
    page,
    '''const PAGE_SIZE = 25;''',
    '''type CandidatePaymentUnitWithClaim = DepositCandidatePaymentUnit & {
  claimed?: boolean;
  claimedComponentId?: string | null;
  claimedBankDepositId?: string | null;
  claimedDepositDate?: string | null;
  claimedDepositAmount?: string | null;
  claimedDepositMemo?: string | null;
  claimedByCurrentDeposit?: boolean;
};

const PAGE_SIZE = 25;''',
    "candidate claim type",
)"""
if old not in text:
    raise SystemExit("candidate claim type patch source not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
