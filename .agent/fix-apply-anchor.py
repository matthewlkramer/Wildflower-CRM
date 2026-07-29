from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")


def replace_checked(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f"{label} not found")
    text = text.replace(old, new, 1)


replace_checked(
    """api = replace_once(
    api,
    '''          payment_unit_id: string;
          unit_id: string;''',
    '''          payment_unit_id: string;
          bank_deposit_id: string;
          component_amount: string;
          unit_id: string;''',
    "component unlink details type",
)""",
    """api = replace_once(
    api,
    '''          id: string;
          source: string;
          payment_unit_id: string;
          unit_id: string;
          minted: boolean;
          has_counted_application: boolean;''',
    '''          id: string;
          source: string;
          payment_unit_id: string;
          bank_deposit_id: string;
          component_amount: string;
          unit_id: string;
          minted: boolean;
          has_counted_application: boolean;''',
    "component unlink details type",
)""",
    "component type anchor",
)

replace_checked(
    """rows = replace_once(
    rows,
    '''      label: charge.payerName ?? charge.chargeId,''',
    '''      label: "Stripe charge accounting",''',
    "charge accounting group label",
)""",
    """rows = replace_once(
    rows,
    '''    ...deposit.charges.map((charge) => ({
      key: `charge-${charge.chargeId}`,
      label: charge.payerName ?? charge.chargeId,
      records: charge.qboRecords ?? [],
    })),''',
    '''    ...deposit.charges.map((charge) => ({
      key: `charge-${charge.chargeId}`,
      label: "Stripe charge accounting",
      records: charge.qboRecords ?? [],
    })),''',
    "charge accounting group label",
)""",
    "charge group anchor",
)

replace_checked(
    """rows = replace_once(
    rows,
    '''      label: componentTitle(component),''',
    '''      label: "Payment accounting",''',
    "component accounting group label",
)""",
    """rows = replace_once(
    rows,
    '''    ...deposit.composition.components.map((component) => ({
      key: `component-${component.componentId}`,
      label: componentTitle(component),
      records: component.qboRecords ?? [],
    })),''',
    '''    ...deposit.composition.components.map((component) => ({
      key: `component-${component.componentId}`,
      label: "Payment accounting",
      records: component.qboRecords ?? [],
    })),''',
    "component accounting group label",
)""",
    "component group anchor",
)

replace_checked(
    """rows = replace_once(
    rows,
    '''      label: gift.name ?? gift.giftId,''',
    '''      label: "Gift accounting",''',
    "gift accounting group label",
)""",
    """rows = replace_once(
    rows,
    '''    ...deposit.gifts.map((gift) => ({
      key: `gift-${gift.giftId}`,
      label: gift.name ?? gift.giftId,
      records: gift.qboRecords ?? [],
    })),''',
    '''    ...deposit.gifts.map((gift) => ({
      key: `gift-${gift.giftId}`,
      label: "Gift accounting",
      records: gift.qboRecords ?? [],
    })),''',
    "gift accounting group label",
)""",
    "gift group anchor",
)

path.write_text(text, encoding="utf-8")
