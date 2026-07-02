#!/bin/bash

# ClassPilot Extension Packaging Script
# This creates a clean ZIP file for Chrome Web Store upload

echo "📦 Packaging ClassPilot Extension..."

# Create output directory
mkdir -p dist

VERSION="$(node -p "require('./extension/manifest.json').version")"
OUTPUT="dist/ClassPilot-v${VERSION}.zip"
COMPAT_OUTPUT="dist/classpilot-extension.zip"

# Remove old package if exists
rm -f "$OUTPUT" "$COMPAT_OUTPUT"

# Navigate to extension directory
cd extension

# Create ZIP with proper structure (files at root, not in subfolder)
# Exclude unnecessary files
zip -r "../$OUTPUT" . \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "dist/*" \
  -x "README.md" \
  -x "COMPLIANCE.md" \
  -x "config.js" \
  -x "config.example.js" \
  -x "create-simple-icons.cjs" \
  -x "icons/generate-icons.js" \
  -x "icons/create_icons.html" \
  -x "icons/README.md" \
  -x ".git/*" \
  -x "*.sh"

cd ..

# Verify package
if [ -f "$OUTPUT" ]; then
  cp "$OUTPUT" "$COMPAT_OUTPUT"
  ZIP_VERSION="$(unzip -p "$OUTPUT" manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).version));")"
  if [ "$ZIP_VERSION" != "$VERSION" ]; then
    echo "❌ Package version mismatch: manifest=$ZIP_VERSION expected=$VERSION"
    exit 1
  fi
  echo "✅ Package created successfully!"
  echo "📍 Location: $OUTPUT"
  echo "📊 Size: $(ls -lh "$OUTPUT" | awk '{print $5}')"
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
