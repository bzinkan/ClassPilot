#!/bin/bash

# ClassPilot Extension Packaging Script
# This creates a clean ZIP file for Chrome Web Store upload

echo "📦 Packaging ClassPilot Extension..."

# Create output directory
mkdir -p dist

# Remove old package if exists
rm -f dist/classpilot-extension.zip

# Navigate to extension directory
cd extension

# Create ZIP with proper structure (files at root, not in subfolder)
# Exclude unnecessary files
zip -r ../dist/classpilot-extension.zip . \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "icons/generate-icons.js" \
  -x "icons/create_icons.html" \
  -x "icons/README.md" \
  -x ".git/*" \
  -x "*.sh"

cd ..

# Verify package
if [ -f "dist/classpilot-extension.zip" ]; then
  echo "✅ Package created successfully!"
  echo "📍 Location: dist/classpilot-extension.zip"
  echo "📊 Size: $(ls -lh dist/classpilot-extension.zip | awk '{print $5}')"
  echo ""
  echo "📝 Contents:"
  unzip -l dist/classpilot-extension.zip | head -20
  echo ""
  echo "✨ Ready to upload to Chrome Web Store!"
  echo "🔗 Upload here: https://chrome.google.com/webstore/devconsole"
else
  echo "❌ Package creation failed"
  exit 1
fi
