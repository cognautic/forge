#!/usr/bin/env bash
set -euo pipefail

log() { echo "[forge-install:macos] $*"; }

log "step 1/9: loading configuration"
REPO="${FORGE_REPO:-cognautic/forge}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
TMP_DIR="$(mktemp -d -t forge-macos-XXXXXX)"
TARGET_DIR="${FORGE_INSTALL_DIR:-/usr/local/bin}"
log "repo=${REPO}"
log "target_dir=${TARGET_DIR}"

cleanup() {
  log "step 9/9: cleaning temporary files"
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

log "step 2/9: checking dependencies"
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

log "step 3/9: fetching latest release metadata"
json="$(curl -fsSL "${API_URL}")"

log "step 4/9: resolving macOS asset URL"
asset_url="$(printf '%s' "${json}" | tr '\n' ' ' | grep -Eo '"browser_download_url":"[^"]+"' | sed -E 's/^"browser_download_url":"(.*)"$/\1/' | grep -E 'cognautic-forge-macos\.tar\.gz$' | head -n1)"
if [[ -z "${asset_url}" ]]; then
  echo "Could not find cognautic-forge-macos.tar.gz in latest release"
  exit 1
fi
log "asset=${asset_url}"

log "step 5/9: downloading release archive"
curl -fL "${asset_url}" -o "${TMP_DIR}/forge.tar.gz"

log "step 6/9: extracting archive"
tar -xzf "${TMP_DIR}/forge.tar.gz" -C "${TMP_DIR}"

log "step 7/9: resolving writable install directory"
if [[ ! -w "${TARGET_DIR}" ]]; then
  TARGET_DIR="${HOME}/.local/bin"
  mkdir -p "${TARGET_DIR}"
  log "switched target_dir=${TARGET_DIR}"
fi

log "step 8/9: installing forge binary"
install -m 0755 "${TMP_DIR}/forge" "${TARGET_DIR}/forge"
log "installed forge to ${TARGET_DIR}/forge"
log "run command: forge"
