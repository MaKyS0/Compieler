#!/usr/bin/env bash
# Builds the offline Android app: web UI + on-device engines -> WebView APK.
# Needs: Node >= 20, JDK 17+, Android SDK (ANDROID_HOME with platforms;android-34 and build-tools;34.0.0).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$root/frontend"
npm ci
npm run build:standalone                      # fetches Pyodide + wasm-clang, builds dist-standalone/

assets="$root/android/app/src/main/assets/www"
rm -rf "$assets" && mkdir -p "$assets"
cp -r dist-standalone/. "$assets/"

cd "$root/android"
[ -f local.properties ] || echo "sdk.dir=${ANDROID_HOME:?set ANDROID_HOME to your Android SDK}" > local.properties
./gradlew --no-daemon assembleRelease

mkdir -p "$root/dist"
cp app/build/outputs/apk/release/app-release.apk "$root/dist/Compieler.apk"
echo "APK: $root/dist/Compieler.apk ($(du -h "$root/dist/Compieler.apk" | cut -f1))"
