#!/usr/bin/env bash
set -euo pipefail

REPO="${FORGE_REPO:-cognautic/forge}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
TMP_DIR="$(mktemp -d -t forge-macos-XXXXXX)"
TARGET_DIR="${FORGE_INSTALL_DIR:-/usr/local/bin}"

cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

json="$(curl -fsSL "${API_URL}")"
asset_url="$(printf '%s' "${json}" | tr '\n' ' ' | grep -Eo '"browser_download_url":"[^"]+"' | sed -E 's/^"browser_download_url":"(.*)"$/\1/' | grep -E 'cognautic-forge-macos\.tar\.gz$' | head -n1)"

if [[ -z "${asset_url}" ]]; then
  echo "Could not find cognautic-forge-macos.tar.gz in latest release"
  exit 1
fi

echo "Downloading ${asset_url}"
curl -fL "${asset_url}" -o "${TMP_DIR}/forge.tar.gz"
tar -xzf "${TMP_DIR}/forge.tar.gz" -C "${TMP_DIR}"

if [[ ! -w "${TARGET_DIR}" ]]; then
  TARGET_DIR="${HOME}/.local/bin"
  mkdir -p "${TARGET_DIR}"
fi

install -m 0755 "${TMP_DIR}/forge" "${TARGET_DIR}/forge"
echo "Installed forge to ${TARGET_DIR}/forge"
echo "Run: forge"
