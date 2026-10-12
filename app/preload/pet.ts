import { contextBridge, ipcRenderer } from 'electron';

// 펫 렌더러에 노출하는 최소 API. 채널을 고정해 임의 IPC 접근을 막음.
contextBridge.exposeInMainWorld('newbiePet', {
  getState: () => ipcRenderer.invoke('pet:getState'),
  checkin: (mood: number, note: string) => ipcRenderer.invoke('pet:checkin', { mood, note }),
  answer: (id: string, text: string, questionText: string) =>
    ipcRenderer.invoke('pet:answer', { id, text, questionText }),
  skip: (id: string) => ipcRenderer.invoke('pet:skip', { id }),
  quit: () => ipcRenderer.send('pet:quit'),
  // 창 이동. 좌표는 main이 OS 커서에서 직접 읽으므로 여기서는 신호만 보낸다.
  // 응답이 필요 없고 드래그 중 매 프레임 오므로 invoke가 아니라 send다
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  // 투명한 여백의 클릭을 아래 창으로 통과시킬지
  setClickThrough: (clickThrough: boolean) => ipcRenderer.send('pet:click-through', clickThrough),
  // 떠돌기. 렌더러가 지금 걸으면 안 되는지 알리고, main이 걷기·쉬기와 방향을 알린다
  setHold: (held: boolean) => ipcRenderer.send('pet:hold', held),
  onMotion: (callback: (motion: { walking: boolean; dir: 1 | -1 }) => void) => {
    ipcRenderer.on('pet:motion', (_event, motion) => callback(motion));
  },
  // 본앱 설정 탭의 "새로고침" — 설정과 이미지를 다시 읽으라는 신호
  onRefresh: (callback: () => void) => {
    ipcRenderer.on('pet:refresh', () => callback());
  },
});
