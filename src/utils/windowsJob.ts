// Windows Job Object로 자식 프로세스의 수명을 앱 프로세스에 묶는다.
//
// before-quit 정리는 앱이 정상 종료될 때만 돈다. 터미널을 강제로 닫거나 앱이
// 크래시하면 JS 코드가 실행될 기회 자체가 없어서, 띄워 둔 자식(dev 서버, MCP
// stdio 서버)이 포트를 문 채 고아로 남는다. 실제로 이렇게 남은 서버가 vite의
// 소켓 핸들을 상속받아 5173이 영영 안 풀리는 일이 있었다.
//
// KILL_ON_JOB_CLOSE 잡을 만들어 핸들을 이 프로세스가 쥐고 있으면, 이 프로세스가
// 어떤 이유로든 죽는 순간 커널이 마지막 핸들을 닫으면서 잡 안의 프로세스를 전부
// 종료한다. 잡에 든 프로세스가 띄우는 자식도 자동으로 같은 잡에 속하므로, 셸만
// 등록해도 셸이 띄운 dev 서버까지 함께 정리된다.
//
// koffi 로드에 실패하는 환경에서는 조용히 비활성화한다 — 그 경우에도
// before-quit의 taskkill 정리는 그대로 남는다.

import { createRequire } from 'node:module';

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

type AssignFn = (pid: number) => boolean;

// undefined = 아직 시도 안 함, null = 사용 불가
let assignFn: AssignFn | null | undefined;

function createAppJob(): AssignFn | null {
  if (process.platform !== 'win32') return null;
  // bun에서는 koffi 네이티브 로드가 프로세스째 크래시한다(try/catch로 못 잡는다).
  // 앱 런타임은 Electron(node)이므로 bun(테스트)에서는 조용히 비활성화한다
  if (process.versions.bun) return null;

  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const koffi = createRequire(import.meta.url)('koffi') as any;
    const kernel32 = koffi.load('kernel32.dll');

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (익명 struct — 이름 등록 충돌 방지)
    const IoCounters = koffi.struct({
      ReadOperationCount: 'uint64',
      WriteOperationCount: 'uint64',
      OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64',
      WriteTransferCount: 'uint64',
      OtherTransferCount: 'uint64',
    });
    const BasicLimitInformation = koffi.struct({
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'size_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    });
    const ExtendedLimitInformation = koffi.struct({
      BasicLimitInformation,
      IoInfo: IoCounters,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });

    const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'void *']);
    const SetInformationJobObject = kernel32.func('SetInformationJobObject', 'bool', [
      'void *', 'int', koffi.pointer(ExtendedLimitInformation), 'uint32',
    ]);
    const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'bool', ['void *', 'void *']);
    const OpenProcess = kernel32.func('OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
    const CloseHandle = kernel32.func('CloseHandle', 'bool', ['void *']);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const job = CreateJobObjectW(null, null);
    if (!job) return null;

    const zeroBasic = {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    };
    const zeroIo = {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    };
    const applied = SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      {
        BasicLimitInformation: zeroBasic,
        IoInfo: zeroIo,
        ProcessMemoryLimit: 0,
        JobMemoryLimit: 0,
        PeakProcessMemoryUsed: 0,
        PeakJobMemoryUsed: 0,
      },
      koffi.sizeof(ExtendedLimitInformation),
    );
    if (!applied) {
      CloseHandle(job);
      return null;
    }

    // 잡 핸들(job)은 여기서 절대 닫지 않는다 — 이 프로세스가 죽을 때 OS가
    // 닫으면서 잡 안의 자식을 전부 종료하는 것이 이 장치의 핵심이다

    return (pid: number) => {
      const proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
      if (!proc) return false;
      try {
        return Boolean(AssignProcessToJobObject(job, proc));
      } finally {
        CloseHandle(proc);
      }
    };
  } catch {
    return null;
  }
}

/**
 * 자식 프로세스를 앱 수명에 묶는다.
 *
 * 실패해도 치명적이지 않다(기존 before-quit 정리가 남는다). 스폰 직후에 불러야
 * 한다 — 등록 전에 그 자식이 또 자식을 띄우면 그 손자는 잡 밖에 남는다.
 */
export function tieProcessToAppLifetime(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (assignFn === undefined) assignFn = createAppJob();
  return assignFn ? assignFn(pid) : false;
}
