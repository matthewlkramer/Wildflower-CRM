from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
start_marker = "text = text.replace(\n    '''        writtenPledge:"
end_marker = "\nschema_marker = \"    MintGiftFromOpportunityBody:\""
start = source.find(start_marker)
end = source.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError("Could not locate brittle writtenPledge OpenAPI patch block")

replacement = r'''written_pattern = re.compile(
    r'(?m)^        writtenPledge:\s+\{ type: boolean(?:, nullable: true)? \}\n'
)
written_matches = list(written_pattern.finditer(text))
if len(written_matches) < 3:
    raise RuntimeError(
        f"Expected response and request writtenPledge properties; found {len(written_matches)}"
    )
first = written_matches[0]
read_only_written = (
    '        writtenPledge:              { type: boolean, readOnly: true, '
    'deprecated: true, description: "Compatibility mirror of '
    'pledgeCommittedAt != null; never write directly." }\n'
)
text = text[: first.start()] + read_only_written + text[first.end() :]
# The lifecycle authority is transition-only. Remove writtenPledge from create,
# update, and bulk request schemas after preserving the response property above.
text = written_pattern.sub("", text)
'''

path.write_text(source[:start] + replacement + source[end:])
