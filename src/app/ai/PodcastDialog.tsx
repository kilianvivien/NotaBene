/**
 * Listen.
 *
 * Two steps, and they are deliberately separate. Writing the script is a
 * provider call over the network; speaking it is a local, offline job that can
 * take minutes on a long note. Fusing them would mean a student who wanted to
 * check what the episode was going to say had to wait for the audio first — and
 * would mean a bad script cost two minutes of synthesis before anyone noticed.
 *
 * Playback is one `<audio>` element pointed at one segment at a time rather
 * than at a joined file, because a joined file cannot be produced until the
 * last segment is spoken and the student should be able to listen to the
 * opening while the rest is still being made. Advancing on `ended` is what
 * turns that into an episode.
 */
import {
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton, GlassSelect } from '@/components/glass';
import type { TtsVoice } from '@/lib/adapters';
import { estimateSpokenMinutes, type PodcastMode } from '@/lib/ai';
import {
  exportPodcastAudioCommand,
  attachPodcastAudioCommand,
  listPodcastVoicesCommand,
  proposePodcastScriptCommand,
  savePodcastScriptToNoteCommand,
  synthesizePodcastCommand,
  type SpokenSegment,
} from '@/lib/commands';
import type { PodcastScript } from '@/lib/schema';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiStatusPill } from './AiStatusPill';
import { useAiAvailability } from './useAiAvailability';

const MODES: PodcastMode[] = ['narrator', 'dialogue'];
const LENGTHS = [3, 6, 10, 15];
const RATES = [0.8, 0.9, 1, 1.15, 1.3];

export function PodcastDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.aiPodcastOpen);
  const setOpen = useUiStore((state) => state.setAiPodcastOpen);
  const multiSelection = useUiStore((state) => state.multiSelection);
  const selectedNoteId = useUiStore((state) => state.selectedNoteId);
  const note = useEditorStore((state) => state.note);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const running = useAiStore((state) => state.running);
  const availability = useAiAvailability('podcast');

  const [script, setScript] = useState<PodcastScript | null>(null);
  const [segments, setSegments] = useState<SpokenSegment[]>([]);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voicesError, setVoicesError] = useState('');
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const noteIds = multiSelection.length
    ? multiSelection
    : selectedNoteId
      ? [selectedNoteId]
      : [];
  const podcast = settings.podcast;
  const writing = running === 'podcast';
  const speaking = running === 'speech';

  /** Ask the engine what it can do only while the panel is open: the list is a
   * subprocess on macOS and nothing else in the app needs it. */
  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      const outcome = await listPodcastVoicesCommand(settings.locale);
      if (!active) return;
      if (!outcome.ok) {
        setVoices([]);
        setVoicesError(t('ai.speechUnavailable'));
        return;
      }
      setVoices(outcome.value);
      setVoicesError('');
      // Pre-select rather than leaving the picker empty: an unset voice would
      // make Speak look broken for the reason least likely to be guessed.
      if (!outcome.value.some((voice) => voice.id === podcast.voiceId)) {
        const first = outcome.value[0];
        if (first) void updateSettings({ podcast: { ...podcast, voiceId: first.id } });
      }
    })();
    return () => {
      active = false;
    };
    // `podcast` is deliberately absent: this runs when the panel opens, and
    // re-running it on every voice change would fight the user's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.locale, t]);

  /** One object URL alive at a time. Without the revoke, a fifteen-minute
   * episode leaks every segment it played for as long as the app is open. */
  function playSegment(index: number) {
    const element = audioRef.current;
    const segment = segments[index];
    if (!element || !segment) return;

    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(segment.audio);
    element.src = urlRef.current;
    setPlaying(index);
    void element.play().catch(() => setPlaying(null));
  }

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  async function writeScript() {
    setError('');
    setStatus('');
    setSegments([]);
    const signal = beginRun('podcast');
    const outcome = await proposePodcastScriptCommand(
      { noteIds, mode: podcast.mode, minutes: podcast.minutes },
      { signal },
    );
    endRun('podcast');

    if (!outcome.ok) {
      setError(
        outcome.code === 'not_supported' ? t('ai.notConfiguredHint') : outcome.message,
      );
      return;
    }
    setScript(outcome.value);
  }

  async function speak() {
    if (!script || !podcast.voiceId) return;
    setError('');
    setStatus('');
    setProgress(0);
    const signal = beginRun('speech');
    const outcome = await synthesizePodcastCommand(script, {
      voiceId: podcast.voiceId,
      rate: podcast.rate,
      signal,
      onProgress: (done, total) => setProgress(done / total),
    });
    endRun('speech');

    if (!outcome.ok) {
      // A cancel is the user's own doing and needs no error line.
      if (outcome.message !== 'cancelled') setError(outcome.message);
      return;
    }
    setSegments(outcome.value);
  }

  async function saveAudio() {
    if (!script) return;
    const outcome = await exportPodcastAudioCommand(script, segments);
    if (!outcome.ok) {
      if (outcome.code !== 'not_supported') setError(outcome.message);
      return;
    }
    setStatus(t('ai.audioSaved'));
  }

  async function attachAudio() {
    if (!script || !note) return;
    const outcome = await attachPodcastAudioCommand(note.id, script, segments);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setStatus(t('ai.audioAttached'));
  }

  async function saveScript() {
    if (!script || !note) return;
    const outcome = await savePodcastScriptToNoteCommand(note.id, script);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setStatus(t('ai.scriptSaved'));
  }

  const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);

  return (
    <Dialog
      open={open}
      onClose={() => {
        cancelRun('podcast');
        cancelRun('speech');
        audioRef.current?.pause();
        setOpen(false);
      }}
      title={t('ai.podcast')}
      description={t('ai.podcastIntro')}
      size="lg"
      headerAction={<AiStatusPill feature="podcast" className="max-w-[200px]" />}
      footer={
        <>
          {writing || speaking ? (
            <GlassButton
              size="sm"
              onClick={() => cancelRun(writing ? 'podcast' : 'speech')}
            >
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" onClick={() => setOpen(false)}>
              {t('common.close')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={script ? 'ghost' : 'accent'}
            disabled={!noteIds.length || !availability.available || writing || speaking}
            onClick={() => void writeScript()}
          >
            {writing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              script && <RefreshCw size={12} />
            )}
            {writing
              ? t('ai.running')
              : script
                ? t('ai.regenerate')
                : t('ai.writeScript')}
          </GlassButton>
          {script && (
            <GlassButton
              size="sm"
              variant="accent"
              disabled={speaking || !podcast.voiceId || !voices.length}
              onClick={() => void speak()}
            >
              {speaking ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Volume2 size={12} />
              )}
              {speaking
                ? t('ai.speakingProgress', { percent: Math.round(progress * 100) })
                : segments.length
                  ? t('ai.speakAgain')
                  : t('ai.speak')}
            </GlassButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <GlassSelect
            label={t('ai.podcastMode')}
            size="sm"
            value={podcast.mode}
            onChange={(event) =>
              void updateSettings({
                podcast: { ...podcast, mode: event.target.value as PodcastMode },
              })
            }
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`ai.podcastMode_${mode}`)}
              </option>
            ))}
          </GlassSelect>
          <GlassSelect
            label={t('ai.podcastLength')}
            size="sm"
            value={String(podcast.minutes)}
            onChange={(event) =>
              void updateSettings({
                podcast: { ...podcast, minutes: Number(event.target.value) },
              })
            }
          >
            {LENGTHS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('ai.podcastMinutes', { count: minutes })}
              </option>
            ))}
          </GlassSelect>
          <GlassSelect
            label={t('ai.voice')}
            size="sm"
            value={podcast.voiceId ?? ''}
            disabled={!voices.length}
            onChange={(event) =>
              void updateSettings({
                podcast: { ...podcast, voiceId: event.target.value },
              })
            }
          >
            {voices.length ? (
              voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} · {voice.locale}
                </option>
              ))
            ) : (
              <option value="">{t('ai.noVoices')}</option>
            )}
          </GlassSelect>
          <GlassSelect
            label={t('ai.speechRate')}
            size="sm"
            value={String(podcast.rate)}
            onChange={(event) =>
              void updateSettings({
                podcast: { ...podcast, rate: Number(event.target.value) },
              })
            }
          >
            {RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate.toFixed(2).replace(/0$/, '')}×
              </option>
            ))}
          </GlassSelect>
        </div>

        {voicesError && <FieldNote tone="danger">{voicesError}</FieldNote>}

        {!script && (
          <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-nb-sm border border-dashed border-[var(--nb-divider)] text-nb-text-3">
            <Volume2 size={26} aria-hidden />
            <p className="max-w-[46ch] px-6 text-center text-[12px] leading-snug">
              {t('ai.podcastEmpty')}
            </p>
            <p className="text-[11px]">
              {t('ai.sourceCount', { count: noteIds.length })}
            </p>
          </div>
        )}

        {script && (
          <>
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {script.title}
              </h3>
              <span className="shrink-0 text-[11px] text-nb-text-3">
                {segments.length
                  ? t('ai.episodeLength', {
                      minutes: Math.max(1, Math.round(totalMs / 60000)),
                    })
                  : t('ai.estimatedLength', { minutes: estimateSpokenMinutes(script) })}
              </span>
            </div>

            <ol className="flex flex-col gap-1">
              {script.segments.map((segment, index) => {
                const spoken = segments[index];
                return (
                  <li key={index}>
                    <button
                      type="button"
                      disabled={!spoken}
                      onClick={() => {
                        if (playing === index && !audioRef.current?.paused) {
                          audioRef.current?.pause();
                          setPlaying(null);
                        } else {
                          playSegment(index);
                        }
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-nb-xs p-1.5 text-left',
                        'transition-colors duration-[var(--nb-t-fast)]',
                        spoken ? 'hover:bg-[var(--nb-hover)]' : 'cursor-default',
                        playing === index && 'bg-[var(--nb-accent-soft)]',
                      )}
                    >
                      <span className="mt-0.5 shrink-0 text-nb-text-3">
                        {playing === index ? <Pause size={12} /> : <Play size={12} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        {script.mode === 'dialogue' && (
                          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
                            {segment.speaker}
                          </span>
                        )}
                        <span className="text-[12px] leading-snug">{segment.text}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-wrap items-center gap-2">
              <GlassButton
                size="sm"
                variant="ghost"
                disabled={!note}
                onClick={() => void saveScript()}
              >
                <FileText size={12} />
                {t('ai.saveScriptToNote')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="ghost"
                disabled={!segments.length}
                onClick={() => void saveAudio()}
              >
                <Download size={12} />
                {t('ai.saveAudio')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="ghost"
                disabled={!segments.length || !note}
                onClick={() => void attachAudio()}
              >
                <FileText size={12} />
                {t('ai.attachAudio')}
              </GlassButton>
            </div>
          </>
        )}

        {status && <FieldNote>{status}</FieldNote>}
        {error && <FieldNote tone="danger">{error}</FieldNote>}

        <audio
          ref={audioRef}
          hidden
          onEnded={() => {
            const next = (playing ?? -1) + 1;
            if (next < segments.length) playSegment(next);
            else setPlaying(null);
          }}
        />
      </div>
    </Dialog>
  );
}
