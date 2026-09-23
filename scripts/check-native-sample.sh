#!/usr/bin/env bash
# T02 smoke check. Requires the pinned local .NET tool and a working DesktopGL host.
set -euo pipefail
cd "$(dirname "$0")/.."
source=samples/GumBridge.Sample
# Keep even partially successful GumCli generation away from repository sources.
test -f .config/dotnet-tools.json
test -f "$source/Content/GumProject/GumProject.gumx"
test -f "$source/GumBridge.Sample.csproj"
work=$(mktemp -d "${TMPDIR:-/tmp}/gum209-native.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
stage="$work/GumBridge.Sample"
mkdir -p "$stage/Content"
cp "$source/GumBridge.Sample.csproj" "$stage/"
cp -R "$source/Content/GumProject" "$stage/Content/"
# Never accept an old ignored FontCache as evidence of fresh font generation.
rm -rf -- "$stage/Content/GumProject/FontCache"
project="$stage/Content/GumProject/GumProject.gumx"
cache="$stage/Content/GumProject/FontCache"
grep -q '<FontGenerator>KernSmith</FontGenerator>' "$project"
DOTNET_ROLL_FORWARD=Major dotnet tool run gumcli -- check "$project"
DOTNET_ROLL_FORWARD=Major dotnet tool run gumcli -- fonts "$project"
test -s "$cache/Font24Arial.fnt" || { echo 'missing generated Arial 24 font' >&2; exit 1; }
test -s "$cache/Font24Arial_0.png" || { echo 'missing generated Arial 24 atlas' >&2; exit 1; }
DOTNET_ROLL_FORWARD=Major dotnet tool run gumcli -- codegen "$project"
test -s "$stage/Screens/PreviewRuntime.Generated.cs" || { echo 'missing staged generated screen' >&2; exit 1; }
output="$work/preview.png"
DOTNET_ROLL_FORWARD=Major dotnet tool run gumcli -- screenshot "$project" Preview --output "$output" --width 800 --height 600 --backend monogame
python3 - "$output" <<'PY'
import struct
import sys
with open(sys.argv[1], 'rb') as f:
    header = f.read(24)
assert header[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', header[16:24]) == (800, 600), 'invalid screenshot PNG'
print('Native Gum 800x600 PNG verified')
PY
