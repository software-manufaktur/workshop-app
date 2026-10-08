#!/usr/bin/env bash
# Prüft die Dateilogik von ios/App/App/SeeYouStoragePlugin.swift ohne Mac:
# Typprüfung + Ausführung gegen Stubs (Capacitor, iCloud). Benötigt eine Swift-Toolchain
# (z. B. Docker-Image swift:6.1-noble). Ersetzt NICHT den Build in Xcode.
set -euo pipefail
cd "$(dirname "$0")"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# @objc wird auf Linux nicht unterstützt – nur für diese Prüfung entfernen
sed -e 's/@objc([A-Za-z]*)//; s/@objc //; /^import Capacitor/d' ../App/App/SeeYouStoragePlugin.swift > "$WORK/Plugin.swift"
swiftc -swift-version 5 Stubs.swift "$WORK/Plugin.swift" main.swift -o "$WORK/plugintest"
mkdir -p "$WORK/home" "$WORK/cloud"
HOME="$WORK/home" FAKE_CLOUD="$WORK/cloud" "$WORK/plugintest"
