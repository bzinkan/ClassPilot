#!/bin/bash

# ClassPilot Extension Packaging Script
# This creates a clean ZIP file for Chrome Web Store upload

echo "📦 Packaging ClassPilot Extension..."

# Create output directory
mkdir -p dist

VERSION="$(node -p "require('./extension/manifest.json').version")"
OUTPUT="dist/ClassPilot-v${VERSION}.zip"
COMPAT_OUTPUT="dist/classpilot-extension.zip"

# Replace only this version and the unversioned compatibility copy. Older
# versioned artifacts are release evidence and must remain recoverable.
rm -f "$OUTPUT" "${OUTPUT}.sha256" "$COMPAT_OUTPUT"

EXCLUDES=(
  "*.DS_Store"
  "__MACOSX/*"
  "dist/*"
  "README.md"
  "COMPLIANCE.md"
  "config.js"
  "config.example.js"
  "create-simple-icons.cjs"
  "icons/generate-icons.js"
  "icons/create_icons.html"
  "icons/README.md"
  ".git/*"
  "*.sh"
)

create_zip_with_powershell() {
  if ! command -v powershell.exe >/dev/null 2>&1; then
    return 1
  fi

  local source_dir output_path
  source_dir="$(cygpath -w "extension")"
  output_path="$(cygpath -w "$OUTPUT")"

  CLASSPILOT_SOURCE_DIR="$source_dir" CLASSPILOT_OUTPUT_PATH="$output_path" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
    $SourceDir = $env:CLASSPILOT_SOURCE_DIR
    $OutputPath = $env:CLASSPILOT_OUTPUT_PATH
    $excludePatterns = @(
      "*.DS_Store",
      "__MACOSX/*",
      "dist/*",
      "README.md",
      "COMPLIANCE.md",
      "config.js",
      "config.example.js",
      "create-simple-icons.cjs",
      "icons/generate-icons.js",
      "icons/create_icons.html",
      "icons/README.md",
      ".git/*",
      "*.sh"
    )

    function Test-Excluded([string]$RelativePath) {
      $normalized = $RelativePath -replace "\\", "/"
      foreach ($pattern in $excludePatterns) {
        $regex = "^" + [regex]::Escape($pattern).Replace("\*", ".*") + "$"
        if ($normalized -match $regex) {
          return $true
        }
      }
      return $false
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $OutputPath) {
      Remove-Item -LiteralPath $OutputPath -Force
    }

    $zip = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      $sourceFull = (Resolve-Path -LiteralPath $SourceDir).Path
      Get-ChildItem -LiteralPath $sourceFull -File -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($sourceFull.Length).TrimStart([char[]]"\/")
        $entryName = $relative -replace "\\", "/"
        if (-not (Test-Excluded $entryName)) {
          [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $_.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
          ) | Out-Null
        }
      }
    } finally {
      $zip.Dispose()
    }
  '
}

# Create ZIP with proper structure (files at root, not in subfolder)
# Exclude unnecessary files.
if command -v zip >/dev/null 2>&1; then
  zip_args=()
  for pattern in "${EXCLUDES[@]}"; do
    zip_args+=("-x" "$pattern")
  done
  (
    cd extension
    zip -r "../$OUTPUT" . "${zip_args[@]}"
  )
elif create_zip_with_powershell; then
  echo "ℹ️  Created package with PowerShell fallback because zip was not available."
else
  echo "❌ Package creation failed: neither zip nor PowerShell fallback is available"
  exit 1
fi

# Verify package
if [ -f "$OUTPUT" ]; then
  cp "$OUTPUT" "$COMPAT_OUTPUT"
  ZIP_VERSION="$(unzip -p "$OUTPUT" manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version));")"
  if [ "$ZIP_VERSION" != "$VERSION" ]; then
    echo "❌ Package version mismatch: manifest=$ZIP_VERSION expected=$VERSION"
    exit 1
  fi
  node scripts/verify-extension-package.mjs "$OUTPUT" --verify-only
  echo "✅ Package created successfully!"
  echo "📍 Location: $OUTPUT"
  echo "📊 Size: $(ls -lh "$OUTPUT" | awk '{print $5}')"
  echo "🔐 SHA-256 record: ${OUTPUT}.sha256"
  echo ""
  echo "📝 Contents:"
  unzip -l "$OUTPUT" | head -20
  echo ""
  echo "✨ Ready to upload to Chrome Web Store!"
  echo "🔗 Upload here: https://chrome.google.com/webstore/devconsole"
else
  echo "❌ Package creation failed"
  exit 1
fi
