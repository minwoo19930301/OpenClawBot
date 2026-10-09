import { readFile } from 'node:fs/promises';
export const MONITOR_ROOM = '00000000-0000-4000-8000-000000000001';
export async function readMonitor(path) {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 16384) throw new Error('size');
    const s = JSON.parse(raw);
    if (!Number.isFinite(s.timestamp) || Date.now() - s.timestamp > 180000 || s.timestamp > Date.now() + 10000) throw new Error('stale');
    for (const k of ['memoryUsedGiB','memoryTotalGiB','diskUsedPercent','diskFreeGiB','communityMemoryGiB','communityLimitGiB','communityCpuLimit','personalLimitGiB','personalCpuLimit']) if (!Number.isFinite(s[k]) || s[k] < 0) throw new Error('invalid');
    return { ...s, available: true };
  } catch { return { available: false }; }
}
export function explainMonitor(s) {
  if (!s.available) return '모니터링 데이터가 없거나 3분 이상 갱신되지 않았습니다. 정상 상태나 무료 사용 중이라고 판단할 수 없습니다. 운영자의 수집기 확인이 필요합니다.';
  return [
    `A1 전체 상태 · ${new Date(s.timestamp).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})} (한국 시간)`,
    s.scope === 'a1-host' ? `CPU: ${s.cpuUsedPercent.toFixed(1)}% / ${s.cpuCount} OCPU` : 'CPU 전체 사용량: 새 수집기 연결 대기',
    `RAM: ${s.memoryUsedGiB.toFixed(2)} / ${s.memoryTotalGiB.toFixed(2)} GiB 사용 (A1 설정 24GB, OS 인식 용량 기준)`,
    s.scope === 'a1-host' ? `전체 디스크: ${s.diskUsedGiB.toFixed(2)} / ${s.diskTotalGiB.toFixed(2)} GiB (${s.diskUsedPercent.toFixed(1)}%) 사용` : '전체 디스크: 새 수집기 연결 대기',
    ...(s.scope === 'a1-host' ? [
      `파일시스템 사용 가능: ${s.diskFreeGiB.toFixed(2)} GiB · 미할당: ${s.diskUnallocatedGiB.toFixed(2)} GiB`,
      ...s.filesystems.map(f => `${f.mount}: ${f.usedGiB.toFixed(2)} / ${f.totalGiB.toFixed(2)} GiB · 여유 ${f.freeGiB.toFixed(2)} GiB${f.usedPercent >= 85 ? ' — 공간 부족 주의' : ''}`),
    ] : []),
    'OpenClawBot은 A1 전체 CPU·RAM을 OS 및 실행 중인 서비스와 공유합니다.',
  ].join('\n');
}
