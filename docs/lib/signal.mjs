/**
 * Timer signals that survive background music on Android.
 *
 * Why HTMLAudioElement and not Web Audio: on Android Chrome/Brave a playing
 * <audio> element joins the tab's media session and requests Android audio
 * focus. Chromium decides the focus type from the clip duration
 * (media/base/media_content_type.cc, kMinimumContentDurationSecs = 5):
 *   - duration > 5 s  -> "persistent" -> AUDIOFOCUS_GAIN: Spotify etc. pause.
 *   - duration <= 5 s -> "transient"  -> GAIN_TRANSIENT_MAY_DUCK: music ducks
 *     and comes back at full volume when the clip ends.
 * A Web Audio oscillator does not take audio focus, so a short quiet beep is
 * simply mixed under the music, which is what Gustaf never heard.
 */

export const SAMPLE_RATE = 22050;
/** Alarm length when the music should pause. Must stay above 5 s. */
export const PAUSE_ALARM_SECONDS = 6;
/** Alarm length when the music should only duck. Must stay at or below 5 s. */
export const DUCK_ALARM_SECONDS = 4.5;
/** A work timer that hit zero longer ago than this is not signalled (no stale alarm). */
export const WORK_END_STALE_MS = 3000;

export const DEFAULT_SIGNAL = Object.freeze({ enabled: true, volume: "high", music: "pause" });
export const VOLUME_LEVELS = Object.freeze({ low: 0.45, medium: 0.75, high: 1 });
export const VOLUME_LABELS = Object.freeze({ low: "Låg", medium: "Mellan", high: "Hög" });
export const MUSIC_LABELS = Object.freeze({ pause: "Pausa musiken", duck: "Sänk musiken en stund" });

/** Vibration patterns (ms on/off). */
export const VIBRATE = Object.freeze({
  alarm: [600, 200, 600, 200, 600, 400, 600, 200, 600, 200, 600],
  tick: [90],
  go: [300],
});

export function normalizeSignal(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled !== false,
    volume: Object.hasOwn(VOLUME_LEVELS, value.volume) ? value.volume : DEFAULT_SIGNAL.volume,
    music: value.music === "duck" ? "duck" : "pause",
  };
}

export function alarmSeconds(music) {
  return music === "duck" ? DUCK_ALARM_SECONDS : PAUSE_ALARM_SECONDS;
}

/** Only 3-2-1 of the 5 s countdown get a pre-beep. */
export function preBeepFor(left) {
  return left >= 1 && left <= 3;
}

/** True when a work timer that reached zero should still ring now. */
export function workEndIsFresh(secondsLeft) {
  return typeof secondsLeft === "number" && secondsLeft <= 0 && -secondsLeft * 1000 <= WORK_END_STALE_MS;
}

/** Loud, harmonically rich tone: half square, half sine, short fades (no clicks). */
function tone(out, startSec, durSec, freq, amp = 0.92) {
  const start = Math.floor(startSec * SAMPLE_RATE);
  const len = Math.floor(durSec * SAMPLE_RATE);
  const fade = Math.min(Math.floor(0.008 * SAMPLE_RATE), Math.floor(len / 4));
  for (let i = 0; i < len && start + i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const phase = 2 * Math.PI * freq * t;
    const sine = Math.sin(phase);
    const square = sine >= 0 ? 1 : -1;
    let env = 1;
    if (i < fade) env = i / fade;
    else if (i > len - fade) env = (len - i) / fade;
    out[start + i] = Math.max(-1, Math.min(1, out[start + i] + amp * env * (0.5 * square + 0.5 * sine)));
  }
}

/**
 * Alarm: three bursts of "bi-bu-bi-bu" (alternating 1400/1900 Hz) spread over
 * the first ~3.8 s, padded with silence to `seconds` so Chromium classifies
 * the clip correctly (see header).
 */
export function alarmSamples(seconds = PAUSE_ALARM_SECONDS) {
  const out = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  const burstStarts = [0, 1.3, 2.6];
  for (const s of burstStarts) {
    for (let k = 0; k < 4; k += 1) tone(out, s + k * 0.24, 0.2, k % 2 ? 1900 : 1400);
  }
  return out;
}

export function preBeepSamples() {
  const out = new Float32Array(Math.ceil(0.18 * SAMPLE_RATE));
  tone(out, 0, 0.15, 1200, 0.8);
  return out;
}

export function goSamples() {
  const out = new Float32Array(Math.ceil(0.5 * SAMPLE_RATE));
  tone(out, 0, 0.45, 1800, 0.9);
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
