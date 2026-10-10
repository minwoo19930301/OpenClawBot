const STATES = { idle: '쉬고 있어요', working: '작업 중', waiting: '응답을 기다리고 있어요', error: '작업을 확인해 주세요' };
export function resolveAgentPresence({ sending = false, rooms = [], hasError = false } = {}) {
  const busy = rooms.filter(room => room.busy);
  if (busy.some(room => room.stage === 'error')) return 'error';
  if (busy.some(room => !['accepted', 'model', 'queued', 'waiting'].includes(room.stage))) return 'working';
  if (busy.length || sending) return 'waiting';
  return hasError ? 'error' : 'idle';
}
export function createAgentPresence({ mount, poster = '/media/agent/idle-poster.jpg' }) {
  const video = document.createElement('video');
  video.className = 'agent-presence-video'; video.muted = true; video.defaultMuted = true;
  video.loop = true; video.autoplay = true; video.playsInline = true; video.preload = 'metadata'; video.poster = poster;
  video.setAttribute('aria-hidden', 'true'); video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.tabIndex = -1;
  const label = document.createElement('span'); label.className = 'sr-only'; label.setAttribute('role', 'status');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active = false, state = 'idle', loadedState = null, failed = false, generation = 0;
  mount.append(video, label); mount.dataset.state = state;
  function playback() {
    if (!active || document.hidden || motion.matches || failed) { video.pause(); return; }
    const sequence = generation;
    const playing = video.play();
    playing?.then(() => { if (sequence === generation) mount.classList.remove('is-paused'); }).catch(() => { if (sequence === generation) mount.classList.add('is-paused'); });
  }
  function set(next = 'idle', visible = true) {
    active = visible; state = Object.hasOwn(STATES, next) ? next : 'idle';
    mount.dataset.state = state; label.textContent = active ? STATES[state] : '';
    mount.setAttribute('aria-label', active ? `에이전트 · ${STATES[state]}` : '에이전트');
    if (active && !motion.matches && loadedState !== state) {
      loadedState = state; failed = false; generation += 1; mount.classList.remove('is-paused');
      video.src = `/media/agent/${state}.mp4`; video.load();
    }
    playback();
  }
  function preferenceChanged() {
    if (motion.matches) { video.pause(); video.removeAttribute('src'); video.load(); loadedState = null; }
    else set(state, active);
  }
  video.addEventListener('error', () => { failed = true; mount.classList.add('is-paused'); });
  video.addEventListener('canplay', playback);
  document.addEventListener('visibilitychange', playback);
  motion.addEventListener?.('change', preferenceChanged);
  return { set, reset: () => set('idle', false), destroy() { active = false; video.pause(); video.removeAttribute('src'); video.load(); document.removeEventListener('visibilitychange', playback); motion.removeEventListener?.('change', preferenceChanged); mount.replaceChildren(); } };
}
