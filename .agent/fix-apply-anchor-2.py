from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
old = """rows = replace_once(
    rows,
    '''  const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;''',
    '''  const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;
  const alignGiftsToStripeCharges = deposit.composition.kind === "stripe_payout";''',
    "stripe gift alignment flag",
)"""
new = """rows = replace_once(
    rows,
    '''const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;''',
    '''const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;
const alignGiftsToStripeCharges = deposit.composition.kind === "stripe_payout";''',
    "stripe gift alignment flag",
)"""
if old not in text:
    raise SystemExit("gift alignment patch source not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
