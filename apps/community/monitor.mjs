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
    `서버 상태 · ${new Date(s.timestamp).toISOString()}`,
    `호스트 RAM: ${s.memoryUsedGiB.toFixed(2)} / ${s.memoryTotalGiB.toFixed(2)} GiB`,
    `커뮤니티 전체: RAM ${s.communityMemoryGiB.toFixed(2)} / ${s.communityLimitGiB} GiB, CPU 상한 ${s.communityCpuLimit}개`,
    `개인 봇 상한: RAM ${s.personalLimitGiB} GiB, CPU ${s.personalCpuLimit}개`,
    `디스크: ${s.diskUsedPercent.toFixed(1)}% 사용, ${s.diskFreeGiB.toFixed(2)} GiB 여유`,
    `강제 제한: ${s.limitsVerified === true ? '확인됨' : '확인 실패 — 운영자 점검 필요'}`,
    s.diskUsedPercent >= 85 ? '주의: 디스크 사용률이 85% 이상입니다. 새 디스크를 자동 구매하지 않습니다.' : '디스크 경고 임계값 미만입니다.',
    s.communityMemoryGiB >= s.communityLimitGiB * .85 ? '주의: 커뮤니티 메모리가 상한의 85% 이상입니다.' : '커뮤니티 메모리 경고 임계값 미만입니다.',
    '정기 감시와 이 답변은 규칙 기반이며 AI API를 호출하지 않습니다. 이 봇은 읽기 전용으로 제한을 변경하지 않습니다.',
    'OCI 청구액은 이 수치로 확인할 수 없습니다. 4 OCPU·24GB는 무료 보장이 아니며, 계정의 무료 한도·디스크·트래픽·모델 API 비용을 별도로 확인해야 합니다.',
  ].join('\n');
}
