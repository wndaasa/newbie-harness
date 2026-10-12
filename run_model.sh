#!/usr/bin/env bash
# llama-server 로 로컬 모델을 OpenAI 호환 API로 띄운다.
#
# 기본값은 Qwen3-8B(Q4_K_M). RTX 4060 Laptop(VRAM 8GB)에서 가중치가 통째로 VRAM에
# 들어가는 가장 큰 축이다. 30B-A3B(MoE)도 돌아가지만 전문가 텐서가 VRAM에 안 들어가
# CPU로 내려가고, 그러면 생성이 CPU 메모리 대역폭에 묶여 14 tok/s에서 천장을 친다.
# 8B는 같은 워크로드에서 35 tok/s가 나오고(프롬프트 처리는 1570 tok/s), CPU가 놀아서
# 발열·팬 소음도 없다. 실측 비교는 아래.
#
#   항목            30B-A3B(전문가 CPU)   8B(전부 GPU)
#   프롬프트         241~299 tok/s        1571 tok/s
#   생성             13.4~14.6 tok/s      34.9 tok/s
#   하네스 턴        57초                 28초
#   CPU load         16코어 풀가동        0.63
#
# ── RX 7800 XT(16GB) + Ryzen 5 9600X + RAM 32GB, Vulkan 백엔드 실측 ──
# 이 조합에서는 30B-A3B가 주력으로 쓸 만하다. 전문가를 전부 CPU로 내릴 필요가
# 없기 때문이다. UD-Q4_K_XL(17.7GB, 전문가 텐서를 더 세게 줄인 판) 기준
# CTX=32768에서 3704토큰 프롬프트로 잰 NCMOE 스윕:
#
#   NCMOE   pp(tok/s)   tg(tok/s)
#   12         213         32.2     VRAM 압박으로 pp 붕괴
#   13         226         33.1     위와 같음
#   14         648         33.4
#   16         661         35.1     ← 최적점
#
# 14 밑으로 내리면 가중치가 VRAM에 겨우 들어가면서 드라이버가 시스템 메모리로
# 흘리기 시작해, 생성은 조금 느려지고 프롬프트 처리는 3배로 무너진다. 위로
# 올리면 CPU가 맡는 전문가가 늘어 단조롭게 느려진다. 바닥 바로 위가 최적이다.
#
# 권장 실행:
#   DEVICE=Vulkan0 \
#   MODEL=$PWD/models/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL.gguf \
#   ALIAS=qwen3-30b-a3b-thinking NCMOE=16 CTX=32768 bash ./run_model.sh
#
# 이 구성으로 하네스에 실제 분석 작업을 시킨 결과 (도구 호출 포함 5턴):
#   프롬프트 14644토큰 / 생성 6795토큰, 전체 307초
#   pp 349~521 tok/s, tg 29.3 → 22.4 tok/s (컨텍스트가 길어질수록 감소)
# CTX를 65536으로 늘리려면 NCMOE=18이 필요하고 tg는 약 5% 준다.
#
# 30B로 되돌리려면(8GB 랩탑 기준):
#   MODEL=$PWD/models/Qwen3-30B-A3B-Thinking-2507-Q4_K_M.gguf \
#   ALIAS=qwen3-30b-a3b-thinking NCMOE=48 CTX=98304 bash ./run_model.sh
#
# 실행 위치를 자동 판별한다:
#   - WSL/Linux : ~/llama.cpp/build/bin/llama-server (llama.cpp를 직접 빌드해 둘 것)
#   - Windows   : tools/llama.cpp/llama-server.exe
#                 (주의: 스마트 앱 제어가 켜져 있으면 서명 미달로 차단된다)
#
# 튜닝 손잡이 (환경변수):
#   MODEL    GGUF 경로
#   ALIAS    API에서 쓸 모델 id. .env 의 LLAMACPP_MODEL 과 맞춰야 화면 표시가 맞는다
#   CTX      컨텍스트 길이 (기본 32768). 8B는 KV가 토큰당 76.5KiB라
#            (36레이어 × KV헤드 8 × head_dim 128 × K,V × 1.0625바이트) 32k에서
#            약 2.4GiB를 쓴다. 가중치 4.7GiB와 합쳐 8GB가 거의 찬다 — 더 늘리기 어렵다.
#   NCMOE    MoE 모델에서 앞쪽 N개 레이어의 전문가를 CPU에 유지. dense 모델(8B)은 0.
#   DEVICE   사용할 백엔드 장치. 비우면 llama.cpp가 보이는 장치 전부에 레이어를
#            분할한다 — 내장 그래픽이 함께 잡히는 기기(예: Ryzen 9600X + RX 7800 XT)
#            에서는 이게 함정이다. iGPU는 VRAM이 아니라 공유 시스템 RAM을 쓰므로
#            그쪽으로 넘어간 레이어가 생성 속도를 통째로 끌어내린다.
#            `llama-server --list-devices` 로 확인하고 외장 카드를 명시할 것.
#            AMD Vulkan 빌드는 보통 DEVICE=Vulkan0.
#   KVQ      KV 캐시 타입. q8_0(기본) / f16(2배 크기, 약간 더 정확)
#   PARALLEL 동시 슬롯 수 (기본 1). 기본값 4로 두면 KV를 여러 슬롯이 나눠 쓴다.
#   HOST     기본 127.0.0.1 (API 키 없는 서버라 0.0.0.0 으로 열면 LAN에 그대로 노출)
#   PORT     기본 8080
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${MODEL:-$HERE/models/Qwen3-8B-Q4_K_M.gguf}"
ALIAS="${ALIAS:-qwen3-8b}"

NCMOE="${NCMOE:-0}"
DEVICE="${DEVICE:-}"
CTX="${CTX:-32768}"
KVQ="${KVQ:-q8_0}"
PARALLEL="${PARALLEL:-1}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"

if [ "$(uname -s)" = "Linux" ]; then
  BIN="${BIN:-$HOME/llama.cpp/build/bin/llama-server}"
else
  BIN="${BIN:-$HERE/tools/llama.cpp/llama-server.exe}"
fi

[ -x "$BIN" ] || { echo "llama-server가 없습니다: $BIN  (Windows는 setup_win_vulkan.sh 실행, Linux는 llama.cpp 직접 빌드)" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "모델 파일이 없습니다: $MODEL" >&2; exit 1; }

# MoE 전용 플래그는 필요할 때만 붙인다 (dense 모델에는 맞는 텐서가 없다)
moe_args=()
[ "$NCMOE" -gt 0 ] && moe_args=(--n-cpu-moe "$NCMOE")

# 장치를 지정하지 않으면 iGPU까지 끌어다 쓴다 (위 DEVICE 설명 참고)
dev_args=()
[ -n "$DEVICE" ] && dev_args=(--device "$DEVICE")

# --jinja 가 핵심이다. 이게 없으면 llama-server는 tools 인자를 받는 즉시
# "tools param requires --jinja flag" 예외를 던진다(server-common.cpp). 하네스는
# 매 턴 도구 19개를 보내므로, 없으면 모든 턴이 실패한다. Qwen3의 tool-call
# 파싱(hermes-2-pro 계열)도 이 플래그로 켜진다.
#
# --reasoning-format deepseek 은 생각을 본문에서 떼어 reasoning_content로 보낸다.
# none으로 두면 <think>...</think> 가 그대로 delta.content 에 섞여 화면과 세션
# 이력을 더럽힌다.
#
# -rea on 은 추론을 기본으로 켠다. Qwen3-8B는 하이브리드라 요청의
# chat_template_kwargs.enable_thinking 으로 이 기본값을 덮을 수 있어서,
# 제목·분류기 같은 짧은 보조 호출만 생각 없이 돌릴 수 있다 (llamacpp.ts 참고).
exec "$BIN" \
  -m "$MODEL" \
  --alias "$ALIAS" \
  -ngl 999 \
  "${moe_args[@]}" \
  "${dev_args[@]}" \
  -fa on \
  --jinja \
  -rea on \
  --reasoning-format deepseek \
  --cache-type-k "$KVQ" \
  --cache-type-v "$KVQ" \
  --ctx-size "$CTX" \
  --parallel "$PARALLEL" \
  --host "$HOST" \
  --port "$PORT"
