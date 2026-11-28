let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

export async function unlockAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

function triggerSingleBellStrike(ctx: AudioContext, startTime: number, baseFreq: number, peakGain: number): void {
  // Harmonic bell partials for a clear metallic chime
  const partials = [
    { ratio: 1, gain: 1.0, decay: 0.95 },
    { ratio: 2.0, gain: 0.45, decay: 0.65 },
    { ratio: 2.98, gain: 0.22, decay: 0.42 },
  ];

  for (const partial of partials) {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * partial.ratio, startTime);

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.linearRampToValueAtTime(peakGain * partial.gain, startTime + 0.012);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + partial.decay);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + partial.decay + 0.05);
  }
}

export async function playBellChime(isOverdue = false): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;

  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }

  if (ctx.state !== 'running') {
    return false;
  }

  const now = ctx.currentTime;
  if (isOverdue) {
    // Urgent crisp double-ring bell (A5 -> C#6)
    triggerSingleBellStrike(ctx, now + 0.01, 880, 0.22);
    triggerSingleBellStrike(ctx, now + 0.24, 1108.73, 0.24);
  } else {
    // Clear approaching-SLA bell chime (G5 -> B5)
    triggerSingleBellStrike(ctx, now + 0.01, 783.99, 0.18);
    triggerSingleBellStrike(ctx, now + 0.28, 987.77, 0.2);
  }

  return true;
}

function triggerSynthTone(
  ctx: AudioContext,
  startTime: number,
  freq: number,
  duration: number,
  peakGain: number,
  type: OscillatorType = 'triangle'
): void {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gainNode.gain.setValueAtTime(0.0001, startTime);
  gainNode.gain.linearRampToValueAtTime(peakGain, startTime + 0.015);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.04);
}

/**
 * Distinct ascending electronic chime for incoming Escalate handoff alerts
 * (clearly different from the metallic SLA overdue bell).
 */
export async function playEscalationIncomingChime(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  if (ctx.state !== 'running') return false;

  const now = ctx.currentTime;
  triggerSynthTone(ctx, now + 0.01, 523.25, 0.22, 0.2, 'triangle'); // C5
  triggerSynthTone(ctx, now + 0.14, 659.25, 0.22, 0.2, 'triangle'); // E5
  triggerSynthTone(ctx, now + 0.27, 783.99, 0.24, 0.22, 'triangle'); // G5
  triggerSynthTone(ctx, now + 0.41, 1046.5, 0.42, 0.24, 'triangle'); // C6
  return true;
}

/**
 * Distinct descending return tone when an escalated case is rejected back to sender.
 */
export async function playEscalationRejectedChime(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  if (ctx.state !== 'running') return false;

  const now = ctx.currentTime;
  triggerSynthTone(ctx, now + 0.01, 698.46, 0.24, 0.2, 'triangle'); // F5
  triggerSynthTone(ctx, now + 0.2, 587.33, 0.24, 0.2, 'triangle'); // D5
  triggerSynthTone(ctx, now + 0.4, 440.0, 0.42, 0.22, 'triangle'); // A4
  return true;
}

/**
 * Distinct chime for new Internal Note bell notifications (3-tone crisp chime for @Mention).
 */
export async function playInternalNoteChime(isMention = false): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  if (ctx.state !== 'running') return false;

  const now = ctx.currentTime;
  if (isMention) {
    triggerSynthTone(ctx, now + 0.01, 587.33, 0.18, 0.15, 'sine'); // D5
    triggerSynthTone(ctx, now + 0.12, 739.99, 0.18, 0.16, 'sine'); // F#5
    triggerSynthTone(ctx, now + 0.24, 880.0, 0.36, 0.18, 'sine'); // A5
  } else {
    triggerSynthTone(ctx, now + 0.01, 587.33, 0.2, 0.14, 'sine'); // D5
    triggerSynthTone(ctx, now + 0.14, 880.0, 0.34, 0.16, 'sine'); // A5
  }
  return true;
}
