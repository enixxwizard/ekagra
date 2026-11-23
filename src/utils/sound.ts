export function playGentleChime(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      // Attempt resume only if allowed by browser autoplay policy; fail silently if blocked
      ctx.resume().catch(() => undefined);
    }
    if (ctx.state === 'suspended') {
      ctx.close().catch(() => undefined);
      return false;
    }

    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 -> E5 -> G5
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);

      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.11, now + idx * 0.14 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.65);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.7);
    });

    window.setTimeout(() => {
      ctx.close().catch(() => undefined);
    }, 1500);
    return true;
  } catch {
    return false;
  }
}
