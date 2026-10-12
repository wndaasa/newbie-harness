#!/usr/bin/env bash
# Windows 네이티브 llama.cpp(Vulkan 백엔드)를 tools/llama.cpp 에 설치한다.
#
# AMD 카드에서는 CUDA 경로가 통째로 무의미하다. NVIDIA는 CUDA 툴킷을 받아 직접
# 빌드하면 되지만, AMD는 다른 백엔드를 골라야 한다.
#
# 왜 ROCm이 아니라 Vulkan인가: llama.cpp 릴리스에 Windows용 ROCm 7.14 프리빌트가
# 있지만, RX 7800 XT(gfx1101)에서 `--list-devices` 가 장치를 하나도 못 본다
# (배포 바이너리에 해당 코드 오브젝트가 없다). Vulkan 빌드는 드라이버만으로 바로
# 잡히고 RDNA3에서 coopmat 행렬 가속도 켜진다. 받는 용량도 35MB 대 242MB다.
#
# 왜 WSL을 안 쓰나: WSL로 우회하는 이유는 스마트 앱 제어(SAC)가 서명 없는
# llama.cpp DLL을 막기 때문이다. SAC가 꺼짐/평가 모드면 그 우회가 필요 없다.
# 확인:  PowerShell> (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
#        0=꺼짐, 2=평가(차단 안 함), 1=적용(차단함 → WSL+Vulkan 경로가 필요)
#
# 사용 (리포 루트에서):  bash ./setup_win_vulkan.sh
#
# 환경변수:
#   BUILD  설치할 llama.cpp 빌드 태그 (기본: 최신 릴리스 자동 조회, 예: b10679)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/tools/llama.cpp"

echo "== 1/4 빌드 태그 확인 =="
# curl 을 grep -m1 에 바로 물리면 grep 이 첫 매치에서 파이프를 닫아버려
# curl 이 쓰기 실패로 종료하고, pipefail 때문에 스크립트 전체가 죽는다.
# 응답을 변수에 먼저 받고 나서 파싱한다.
if [ -z "${BUILD:-}" ]; then
  releases="$(curl -sSL 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=1')"
  BUILD="$(printf '%s' "$releases" | grep '"tag_name"' | head -1 | sed 's/.*: *"//; s/".*//')"
fi
[ -n "$BUILD" ] || { echo "릴리스 태그를 못 가져왔습니다. BUILD=b10679 처럼 직접 지정하세요." >&2; exit 1; }
echo "빌드: $BUILD"

ZIP="llama-$BUILD-bin-win-vulkan-x64.zip"
URL="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/$ZIP"

echo "== 2/4 내려받기 ($ZIP, 약 35MB) =="
mkdir -p "$HERE/tools"
if [ ! -f "$HERE/tools/$ZIP" ]; then
  curl -sSL -o "$HERE/tools/$ZIP" "$URL"
fi

echo "== 3/4 압축 풀기 -> tools/llama.cpp =="
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q -o "$HERE/tools/$ZIP" -d "$DEST"
[ -x "$DEST/llama-server.exe" ] || { echo "llama-server.exe 가 없습니다. 압축 구조를 확인하세요." >&2; exit 1; }

echo "== 4/4 장치 확인 =="
"$DEST/llama-server.exe" --list-devices

cat <<'EOF'

완료: tools/llama.cpp/llama-server.exe

주의: 위 목록에 장치가 둘 이상이면(외장 카드 + CPU 내장 그래픽) 반드시 DEVICE 를
지정하세요. 비워 두면 llama.cpp가 두 장치에 레이어를 나눠 싣고, 공유 시스템 RAM을
쓰는 iGPU 쪽이 병목이 되어 생성 속도가 무너집니다.

다음:  DEVICE=Vulkan0 bash ./run_model.sh
EOF
