// 펫 렌더러 — 타이머와 표시만 담당. 판단·저장은 전부 main 프로세스(IPC) 뒤의
// 공유 저장소가 한다. 톤: 빠진 날 지적 금지, 조용한 완료.
const bubble = document.getElementById('bubble');
const pet = document.getElementById('pet');
const petImage = document.getElementById('pet-image');
const askBtn = document.getElementById('btn-now');

let intervalMinutes = 60;
let quietHours = { start: '23:00', end: '08:00' };
let askQuestions = true;
let askCheckin = true;
let roam = false;
let nextPromptAt = Date.now() + 10_000; // 시작 10초 후 첫 확인

// ---------- 표정 ----------
//
// 표정은 상태가 아니라 반응이다. 기록을 받은 직후 잠깐 짓고 무표정으로 돌아온다 —
// 슬픈 얼굴로 하루 종일 앉아 있으면 그날 기분을 박제하는 꼴이고, 사용자가 자기
// 기분을 계속 마주보게 만든다. 완료 말풍선(1.8초)보다 조금 더 남아, 마지막에
// 보이는 것이 펫의 표정이 되게 한다.
const REST_FACE = 'face-rest'; // 평소 얼굴 — 입이 없다
const FACES = ['face-rest', 'face-sad', 'face-neutral', 'face-smile', 'face-grin'];
const FACE_HOLD_MS = 2600;
const GIGGLE_MS = 900; // CSS @keyframes giggle과 같은 길이
let faceTimer = null;
let giggling = false;

// giggle 클래스는 건드리지 않는다 — className 통째 대입은 진행 중인 흔들림을 끊는다
function setFace(face) {
  pet.classList.remove(...FACES);
  pet.classList.add(face);
}

function moodFace(mood) {
  if (!Number.isInteger(mood)) return 'neutral';
  if (mood <= 4) return 'sad';
  if (mood === 5) return 'neutral';
  if (mood <= 8) return 'smile';
  return 'grin';
}

function reactMood(mood) {
  clearTimeout(faceTimer);
  setFace(`face-${moodFace(mood)}`);
  faceTimer = setTimeout(() => {
    setFace(REST_FACE);
    faceTimer = null;
  }, FACE_HOLD_MS);
}

// 커서가 닿거나 누르면 웃는다. 기분 반응이 떠 있는 동안(faceTimer)에는 무시한다 —
// 방금 1점을 기록한 펫이 커서가 스쳤다고 깔깔대면 사용자를 놀리는 꼴이 된다.
function giggle() {
  if (giggling || faceTimer) return;
  giggling = true;
  setFace('face-grin');
  pet.classList.add('giggle');
  setTimeout(() => {
    pet.classList.remove('giggle');
    setFace(REST_FACE);
    giggling = false;
  }, GIGGLE_MS);
}

// 웃음은 한 번 터지고 끝나지만(giggle), 얼굴이 달아오른 상태는 커서가 머무는
// 동안 유지된다 — 관심을 주는 만큼 온기가 남는다는 뜻. 웃음이 눌린 상황(기분
// 반응 중)에도 온기는 켠다: 표정과 무관한 별개의 신호다.
function onPetEnter() {
  pet.classList.add('warm');
  giggle();
}

function onPetLeave() {
  if (dragging) return; // 옮기는 중에는 커서가 벗어나도 온기를 유지한다
  pet.classList.remove('warm');
}

// ---------- 떠돌기 ----------
//
// 창을 옮기는 건 main(petRoam.ts)이다. 렌더러는 지금 걸으면 안 되는지만 알린다 —
// 누르려는 버튼이 도망가거나, 답을 쓰는 말풍선이 미끄러지면 안 된다.
// hovering은 말풍선·툴바 위, petHit은 펫의 보이는 부분 위에 커서가 있는지다.
let hovering = 0;
let lastHold = null;

// 창은 240×320인데 보이는 건 펫·말풍선·툴바뿐이다. 나머지 투명한 여백이 클릭을
// 삼키면 펫 근처의 작업 표시줄이나 다른 창을 누를 수 없다. 커서가 보이는 요소 위에
// 있거나 잡아 끄는 중일 때만 마우스를 받고, 그 밖에는 아래로 통과시킨다.
// 통과 중에도 main이 커서 이동은 넘겨주므로(forward) mousemove·mouseenter는 그대로 온다.
let lastClickThrough = null;

function pointerOver() {
  return hovering > 0 || petHit;
}

function updatePointer() {
  const clickThrough = !dragging && !pointerOver();
  if (clickThrough === lastClickThrough) return;
  lastClickThrough = clickThrough;
  window.newbiePet.setClickThrough(clickThrough);
}

function updateHold() {
  updatePointer();
  const held =
    !roam || dragging || pointerOver() || bubble.classList.contains('visible') || inQuietHours();
  if (held === lastHold) return;
  lastHold = held;
  window.newbiePet.setHold(held);
}

// ---------- 펫 판정 ----------
//
// 펫은 상자(92×92)가 아니라 보이는 픽셀로 판정한다. 사용자 이미지는 object-fit:
// contain으로 남는 자리와 그림 속 투명한 부분이 많아서, 상자로 판정하면 보이지 않는
// 사각형이 그 아래 창의 클릭을 가로막는다. 그린 얼굴은 원형 상자(border-radius) 그대로다.
// 지금 보이는 프레임의 알파를 커서 위치에서 읽어 거의 투명하면 펫이 아닌 것으로 본다.
const ALPHA_THRESHOLD = 16; // 0~255. 이펙트 가장자리의 옅은 번짐까지 잡지는 않는다
let petHit = false;
let dir = 1;
// 프레임(src)마다 알파만 담아 둔다. 시퀀스가 바뀌면 applyState가 비운다
const alphaCache = new Map();

function alphaOf(src) {
  let entry = alphaCache.get(src);
  if (entry) return entry;
  const { naturalWidth: width, naturalHeight: height } = petImage;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(petImage, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  entry = { width, height, alpha };
  alphaCache.set(src, entry);
  return entry;
}

function opaqueAt(x, y) {
  const src = petImage.getAttribute('src');
  // 아직 디코딩 전이면 상자로 판정한다 — 잠깐 못 만지는 것보다 낫다
  if (!src || !petImage.complete || !petImage.naturalWidth) return true;
  const { width, height, alpha } = alphaOf(src);
  // 화면상 크기는 회전(giggle·뒤뚱걸음)을 빼고 contain 배율로 계산한다. 중심은
  // 바운딩 박스 중심으로 잡는다 — 작은 회전이나 좌우 반전에도 그대로다
  const rect = petImage.getBoundingClientRect();
  const scale = Math.min(petImage.offsetWidth / width, petImage.offsetHeight / height);
  let u = (x - (rect.left + rect.width / 2)) / scale;
  const v = (y - (rect.top + rect.height / 2)) / scale;
  if (dir === -1) u = -u; // 이미지는 가는 쪽을 보게 scaleX(--dir)로 뒤집혀 있다
  const px = Math.floor(u + width / 2);
  const py = Math.floor(v + height / 2);
  if (px < 0 || py < 0 || px >= width || py >= height) return false;
  return alpha[py * width + px] > ALPHA_THRESHOLD;
}

function hitsPet(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !pet.contains(el)) return false;
  return pet.classList.contains('custom') ? opaqueAt(x, y) : true;
}

function setPetHit(hit) {
  if (hit === petHit) return;
  petHit = hit;
  if (hit) onPetEnter();
  else onPetLeave();
  updateHold();
}

document.addEventListener('mousemove', event => {
  setPetHit(hitsPet(event.clientX, event.clientY));
});
// 창 밖으로 나가면 더 이상 mousemove가 오지 않는다
document.documentElement.addEventListener('mouseleave', () => setPetHit(false));

for (const el of [bubble, document.getElementById('toolbar')]) {
  el.addEventListener('mouseenter', () => {
    hovering++;
    updateHold();
  });
  el.addEventListener('mouseleave', () => {
    hovering = Math.max(0, hovering - 1);
    updateHold();
  });
}

window.newbiePet.onMotion(motion => {
  const { walking } = motion;
  dir = motion.dir;
  pet.style.setProperty('--dir', String(dir));
  pet.classList.toggle('walk', walking);
  renderPetImage();
});

// ---------- 플립북 ----------
//
// 시퀀스가 둘이다. idle은 걷지 않을 때 늘 넘긴다 — 가만히 있어도 미세하게 움직여야
// 살아 있는 것처럼 보인다. walk는 떠돌기로 걷는 동안만 넘기고, 멈추면 idle로 돌아간다.
// walk가 비어 있으면 걷는 동안에도 idle을 넘기고, 걷는다는 표시로 뒤뚱걸음을 얹는다.
// 창 이동은 그대로 main이 한다 — 여기서는 그림만 바꾼다.
//
// 시퀀스가 하나도 없으면 펫 이미지를, 그것도 없으면 그린 얼굴을 보인다.
// 모션 줄이기를 켠 사람에게는 넘기지 않고 지금 시퀀스의 첫 장만 보인다.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const NO_ANIMATION = { frames: [], frameMs: 140 };
let animations = { idle: NO_ANIMATION, walk: NO_ANIMATION };
let stillImage = '';
let currentSlot; // 처음 한 번은 반드시 그리도록 undefined로 시작
let frameTimer = null;
let frameIndex = 0;

function stopFlipbook() {
  clearInterval(frameTimer);
  frameTimer = null;
}

function showImage(src) {
  // 같은 data URL을 다시 넣어도 다시 디코딩하지 않지만, 문자열 비교가 더 싸다
  if (petImage.getAttribute('src') !== src) petImage.src = src;
}

function activeSlot() {
  if (pet.classList.contains('walk') && animations.walk.frames.length > 0) return 'walk';
  if (animations.idle.frames.length > 0) return 'idle';
  return null;
}

// 시퀀스가 바뀔 때만 처음 장부터 다시 건다. 같은 시퀀스면 넘기던 흐름을 끊지 않는다 —
// 걷기 시작·멈춤마다 idle이 첫 장으로 튀면 끊겨 보인다. force는 시퀀스 내용이 바뀐 경우다
function renderPetImage(force = false) {
  const slot = activeSlot();
  // 걷기 시퀀스가 걸음을 맡을 때만 뒤뚱걸음을 끈다(CSS #pet.flipbook)
  pet.classList.toggle('flipbook', slot === 'walk' && animations.walk.frames.length > 1);
  if (slot === currentSlot && !force) return;
  currentSlot = slot;
  stopFlipbook();
  frameIndex = 0;

  if (!slot) {
    // 걷기 시퀀스만 있는 펫은 쉴 때 그 첫 장으로 선다 — 그린 얼굴로 돌아가면 다른 펫이 된다
    const still = stillImage || animations.walk.frames[0] || '';
    if (still) showImage(still);
    return;
  }
  const { frames, frameMs } = animations[slot];
  showImage(frames[0]);
  if (frames.length < 2 || reducedMotion.matches) return;
  frameTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    showImage(frames[frameIndex]);
  }, frameMs);
}

function sameAnimation(a, b) {
  return (
    a.frameMs === b.frameMs &&
    a.frames.length === b.frames.length &&
    a.frames.every((frame, i) => frame === b.frames[i])
  );
}

// ---------- 창 이동 ----------
//
// 펫을 잡고 끌면 창이 따라온다. -webkit-app-region: drag를 쓰면 간단하지만 그 영역은
// 마우스 이벤트를 창 이동으로 삼켜서 hover·click이 여기까지 오지 않는다. 만지는 것과
// 옮기는 것을 같은 자리에서 둘 다 받으려면 드래그를 직접 처리하는 수밖에 없다.
const DRAG_THRESHOLD_PX = 4; // 이만큼 넘게 움직였으면 클릭이 아니라 드래그로 본다
let dragging = false;
let dragDistance = 0;
let dragged = false;

pet.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  // 마우스를 받은 직후 투명한 부분을 누른 경우 — 펫을 잡은 게 아니다
  setPetHit(hitsPet(event.clientX, event.clientY));
  if (!petHit) return;
  dragging = true;
  dragDistance = 0;
  dragged = false;
  updateHold();
  window.newbiePet.dragStart();
});

// 펫 밖으로 커서가 나가도 계속 따라오도록 document에서 받는다.
// 이동량은 movementX/Y로 누적한다 — 창이 커서를 따라오므로 clientX는 거의 제자리고,
// screenX는 배율에 따라 단위가 어긋난다. movement은 커서가 실제로 움직인 델타다.
document.addEventListener('mousemove', event => {
  if (!dragging) return;
  dragDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
  if (dragDistance > DRAG_THRESHOLD_PX) dragged = true;
  window.newbiePet.dragMove();
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  updateHold();
  window.newbiePet.dragEnd();
  // 끄는 동안 펫 밖으로 나갔으면 온기를 유지해 두었으므로 여기서 정리한다
  if (!petHit) pet.classList.remove('warm');
});

// 옮길 때마다 손을 떼면서 웃으면 성가시다 — 실제로 움직였으면 웃음은 건너뛴다
pet.addEventListener('click', () => {
  if (!dragged && petHit) giggle();
});

function hhmmToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function inQuietHours(now = new Date()) {
  const start = hhmmToMinutes(quietHours?.start);
  const end = hhmmToMinutes(quietHours?.end);
  if (start === null || end === null) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  // 자정을 넘는 구간(예: 23:00~08:00) 지원
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

function hideBubble() {
  bubble.classList.remove('visible');
  bubble.innerHTML = '';
  // 말풍선이 사라지면 그 위에 있던 커서의 mouseleave가 오지 않을 수 있다
  hovering = document.getElementById('toolbar').matches(':hover') ? 1 : 0;
  updateHold();
}

function showBubble() {
  bubble.classList.add('visible');
  updateHold();
}

function showQuiet(text, ms = 1800) {
  bubble.innerHTML = `<div class="q-text">${text}</div>`;
  showBubble();
  setTimeout(hideBubble, ms);
}

function deferPrompt() {
  nextPromptAt = Date.now() + intervalMinutes * 60_000;
}

// 설정과 이미지는 상태를 읽을 때마다 다시 적용한다 — 본앱 설정 탭이 pet.json을
// 고친 뒤 새로고침 신호를 보내거나, 주기 동기화가 돌 때 따라오게 하기 위해서다
function applyState(state) {
  intervalMinutes = state.settings.intervalMinutes;
  quietHours = state.settings.quietHours;
  askQuestions = state.settings.askQuestions;
  askCheckin = state.settings.askCheckin;
  roam = state.settings.roam;
  updateHold();
  // 이미지나 시퀀스가 있으면 그린 얼굴 대신 보인다. 표정·색은 CSS(#pet.custom)가 무시한다
  const next = state.animations ?? { idle: NO_ANIMATION, walk: NO_ANIMATION };
  // 주기 동기화마다 넘기던 흐름을 처음부터 다시 걸지 않게, 바뀌었을 때만 다시 건다
  const changed =
    !sameAnimation(next.idle, animations.idle) || !sameAnimation(next.walk, animations.walk);
  animations = next;
  const nextStill = state.imageDataUrl || '';
  // 쓰지 않게 된 프레임의 알파를 들고 있지 않는다
  if (changed || nextStill !== stillImage) alphaCache.clear();
  stillImage = nextStill;
  const hasPicture = Boolean(
    stillImage || animations.idle.frames.length || animations.walk.frames.length,
  );
  pet.classList.toggle('custom', hasPicture);
  if (!hasPicture) petImage.removeAttribute('src');
  renderPetImage(changed);
}

// 질문하기가 꺼져 있으면 대기 질문이 있어도 없는 것으로 본다. 큐는 건드리지
// 않으므로 CLI /checkin에서는 여전히 볼 수 있고, 다시 켜면 그대로 나온다
function askableQuestion(state) {
  return askQuestions ? state.question : null;
}

// 체크인 권유가 꺼져 있으면 오늘 체크인이 없어도 권하지 않는다. CLI /checkin은 그대로다
function needsCheckin(state) {
  return askCheckin && !state.hasTodayCheckin;
}

// 💭는 "지금 확인" 버튼이다. 물을 것이 없으면 눌러도 조용히 사라지기만 해서
// 고장처럼 보인다 — 그럴 때는 버튼 자체를 감춘다. 오늘 체크인을 이미 했고 대기 중인
// 확인 질문도 없을 때가 그 상태다. /distill이 새 질문을 만들면 다시 나타난다.
async function syncAskButton() {
  const state = await window.newbiePet.getState();
  applyState(state);
  const hasSomethingToAsk = Boolean(askableQuestion(state)) || needsCheckin(state);
  askBtn.style.display = hasSomethingToAsk ? '' : 'none';
}

function showQuestion(question) {
  bubble.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'q-text';
  text.textContent = `💭 ${question.text}`;

  const input = document.createElement('textarea');
  input.placeholder = '답변 (선택)';

  const row = document.createElement('div');
  row.className = 'row';
  const answerBtn = document.createElement('button');
  answerBtn.textContent = '답하기';
  answerBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) return;
    await window.newbiePet.answer(question.id, value, question.text);
    deferPrompt();
    showQuiet('고마워요, 기억해둘게요.');
    void syncAskButton();
  });
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '넘기기';
  skipBtn.addEventListener('click', async () => {
    await window.newbiePet.skip(question.id);
    deferPrompt();
    hideBubble();
    void syncAskButton();
  });
  row.append(answerBtn, skipBtn);

  bubble.append(text, input, row);
  showBubble();
}

function showCheckin() {
  bubble.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'q-text';
  text.textContent = '오늘 어때? (1~10)';

  const grid = document.createElement('div');
  grid.className = 'mood-grid';
  for (let mood = 1; mood <= 10; mood++) {
    const btn = document.createElement('button');
    btn.textContent = String(mood);
    // 여기서 저장하지 않는다 — 기록은 append-only라 나중에 메모를 덧붙일 수 없고,
    // 그날 두 번째 체크인은 앞 기록을 덮는다. 저장 전에 메모를 받을 기회가 한 번은 있어야 한다
    btn.addEventListener('click', () => showCheckinNote(mood));
    grid.append(btn);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const laterBtn = document.createElement('button');
  laterBtn.textContent = '나중에';
  laterBtn.addEventListener('click', () => {
    deferPrompt();
    hideBubble();
  });
  row.append(laterBtn);

  bubble.append(text, grid, row);
  showBubble();
}

// 체크인 2단계 — 저장은 여기서만 일어난다
function showCheckinNote(mood) {
  bubble.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'q-text';
  text.textContent = `기분 ${mood}/10. 더 남길 말 있나요?`;

  const note = document.createElement('input');
  note.placeholder = '한 줄 메모 (선택)';

  const row = document.createElement('div');
  row.className = 'row';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '기록하기';
  const save = async () => {
    saveBtn.disabled = true; // 연타로 같은 날 기록이 두 줄 생기지 않게
    // 저장에 실패했는데 표정만 바뀌면 기록된 것처럼 보인다 — 성공했을 때만 반응
    if (await window.newbiePet.checkin(mood, note.value)) reactMood(mood);
    deferPrompt();
    showQuiet('기록했어요.');
    void syncAskButton();
  };
  saveBtn.addEventListener('click', save);
  note.addEventListener('keydown', event => {
    if (event.key === 'Enter') void save();
  });

  const backBtn = document.createElement('button');
  backBtn.textContent = '뒤로';
  backBtn.addEventListener('click', showCheckin); // 아직 저장 전이라 기분을 다시 고를 수 있다

  row.append(saveBtn, backBtn);
  bubble.append(text, note, row);
  showBubble();
  note.focus();
}

async function promptNow() {
  const state = await window.newbiePet.getState();
  applyState(state);

  const question = askableQuestion(state);
  if (question) {
    showQuestion(question);
  } else if (needsCheckin(state)) {
    showCheckin();
  } else {
    // 물을 것이 없으면 조용히 물러난다 — 빈 말풍선으로 조르지 않기
    hideBubble();
  }
  deferPrompt();
}

async function tick() {
  updateHold(); // 조용한 시간에 들어서거나 벗어나면 따라간다
  if (Date.now() < nextPromptAt) return;
  if (inQuietHours()) {
    deferPrompt();
    return;
  }
  if (bubble.classList.contains('visible')) return; // 열려 있으면 방해하지 않음
  await promptNow();
}

setInterval(tick, 30_000);

// CLI에서 /checkin을 하거나 /distill이 새 질문을 만들어도 버튼 상태가 따라오게 한다
setInterval(syncAskButton, 60_000);
void syncAskButton();
// 본앱 설정 탭의 새로고침 — 페이지를 다시 읽지 않는다. 그러면 타이머가 초기화돼
// 설정을 만졌다는 이유로 10초 뒤 말을 걸게 된다
window.newbiePet.onRefresh(() => void syncAskButton());

askBtn.addEventListener('click', promptNow);
document.getElementById('btn-close').addEventListener('click', () => window.newbiePet.quit());
