from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text()

# Remove the brittle OpportunityType-adjacent enum insertion. The current
# OpenAPI spacing changed, so that no-op left valid $refs without generated
# declarations. The enums are inserted below with the transition schemas,
# whose marker is explicitly validated by the payload.
enum_start = "text = text.replace(\n    '''    OpportunityType:"
enum_end = "\n\ntext = text.replace(\n    '''        stage:"
es = source.find(enum_start)
ee = source.find(enum_end, es)
if es < 0 or ee < 0:
    raise RuntimeError("Could not locate brittle commitment-enum insertion")
source = source[:es] + source[ee + 2 :]
source = source.replace(
    "transition_schemas = '''    RecordVerbalCommitmentBody:\n",
    '''transition_schemas = ''' + "'''" + '''    OpportunityCommitmentPath:
      type: string
      enum: [gift, written_pledge, verbal_pledge]
      description: The positive outcome the donor verbally confirmed; not itself an actual pledge or gift.
    OpportunityOutcomeType:
      type: string
      enum: [gift, pledge]
      description: Actual positive outcome, derived from pledge finalization or received money.
    RecordVerbalCommitmentBody:
''',
    1,
)

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

source = source[:start] + replacement + source[end:]
# Inline YAML maps split unquoted comma-containing descriptions into bogus
# properties. Quote any 409 description in the staged endpoint block that
# contains commas.
source = re.sub(
    r'(?m)^(\s+"409": \{ description: )([^"\n]*,[^"\n]*)( \})$',
    lambda m: f'{m.group(1)}"{m.group(2)}"{m.group(3)}',
    source,
)
path.write_text(source)
