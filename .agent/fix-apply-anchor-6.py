from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
anchor = """recent_test = replace_once(
    recent_test,
    '''      expect(json.items.every((item) => item.undo != null)).toBe(true);''',
    '''      expect(json.items.some((item) => item.undo == null)).toBe(true);''',
    "recent test nullable undo",
)"""
replacement = anchor + """
recent_test = replace_once(
    recent_test,
    '''      expect(byId.has(malformedUndoId)).toBe(false);''',
    '''      expect(byId.get(malformedUndoId)).toMatchObject({
        summary: `${RUN} action with bogus undo`,
        undo: null,
      });''',
    "recent test malformed undo visible",
)"""
if anchor not in text:
    raise SystemExit("recent test nullable-undo anchor not found")
path.write_text(text.replace(anchor, replacement, 1), encoding="utf-8")
