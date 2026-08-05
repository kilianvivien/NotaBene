import { Download, HardDrive, Loader2, Trash2, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FieldNote, GlassButton } from '@/components/glass';
import {
  LOCAL_MODEL_REVISIONS,
  localTtsModels,
  ttsRegistry,
  type LocalModelStatus,
  type ManagedLocalEngineId,
} from '@/lib/adapters';
import { useSpeechStore } from '@/lib/state/speechStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { formatBytes } from '@/lib/utils/formatBytes';

interface LocalSpeechModelCardProps {
  id: ManagedLocalEngineId;
  onChanged(): Promise<void>;
}

export function LocalSpeechModelCard({ id, onChanged }: LocalSpeechModelCardProps) {
  const { t } = useTranslation();
  const speech = useSettingsStore((state) => state.settings.speech);
  const locale = useSettingsStore((state) => state.settings.locale);
  const update = useSettingsStore((state) => state.update);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const prefix = id === 'voxtral-local' ? 'voxtral' : 'kokoro';

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void localTtsModels
      .status(id)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    void localTtsModels
      .listen(id, (next) => {
        if (active) setStatus(next);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [id]);

  const progress = useMemo(() => {
    if (!status?.totalBytes) return 0;
    return Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100));
  }, [status]);
  const installing = status?.kind === 'downloading' || status?.kind === 'verifying';
  const ready = status?.kind === 'ready' || status?.kind === 'loading';

  async function run(action: () => Promise<LocalModelStatus>): Promise<boolean> {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      setStatus(await action());
      await onChanged();
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.startsWith('TTS_CANCELLED:')) {
        setNotice(t('speech.installCancelled'));
      } else {
        setError(message);
      }
      setStatus(await localTtsModels.status(id).catch(() => status));
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function install() {
    if (!(await run(() => localTtsModels.install(id, accepted)))) return;
    const next = useSettingsStore.getState().settings.speech;
    await update({
      speech: {
        ...next,
        engineId: id,
        localModelRevisions: {
          ...next.localModelRevisions,
          [id]: LOCAL_MODEL_REVISIONS[id],
        },
      },
    });
  }

  async function selectModel() {
    useSpeechStore.getState().stop();
    await update({
      speech: {
        ...speech,
        engineId: id,
        localModelRevisions: {
          ...speech.localModelRevisions,
          [id]: LOCAL_MODEL_REVISIONS[id],
        },
      },
    });
  }

  async function testVoice() {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const engine = ttsRegistry.get(id);
      const voices = await engine.listVoices();
      const voice =
        voices.find((candidate) => candidate.id === speech.voicesByEngine[id]) ??
        voices.find((candidate) => candidate.locale.startsWith(locale)) ??
        voices[0];
      if (!voice) throw new Error(t('speech.noVoices'));
      const result = await engine.synthesize({
        text: t('speech.testPhrase'),
        voiceId: voice.id,
      });
      const url = URL.createObjectURL(result.audio);
      const player = new Audio(url);
      player.addEventListener('ended', () => URL.revokeObjectURL(url), {
        once: true,
      });
      await player.play();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    if (!(await run(() => localTtsModels.remove(id)))) return;
    const next = useSettingsStore.getState().settings.speech;
    const localModelRevisions = { ...next.localModelRevisions };
    const voicesByEngine = { ...next.voicesByEngine };
    delete localModelRevisions[id];
    delete voicesByEngine[id];
    await update({
      speech: {
        ...next,
        engineId: next.engineId === id ? 'system' : next.engineId,
        localModelRevisions,
        voicesByEngine,
      },
    });
  }

  return (
    <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-nb-xs bg-[var(--nb-active)] p-2 text-nb-text-2">
          <HardDrive size={16} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] font-medium">{t(`speech.${prefix}Title`)}</p>
              <p className="text-[11px] text-nb-text-3">
                {t(`speech.${prefix}Size`, {
                  size: formatBytes(status?.modelSizeBytes ?? 0, locale),
                })}
              </p>
            </div>
            <span className="rounded-full bg-[var(--nb-active)] px-2 py-0.5 text-[10px] text-nb-text-2">
              {t(`speech.state_${status?.kind ?? 'not_installed'}`)}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-nb-text-2">
            {t(`speech.${prefix}Description`)}
          </p>

          {installing && (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[10px] text-nb-text-3">
                <span>{t(`speech.state_${status.kind}`)}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--nb-active)]">
                <div
                  className="h-full rounded-full bg-[var(--nb-accent)] transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {!ready && !installing && status?.kind !== 'unsupported' && (
            <label className="mt-3 flex items-start gap-2 text-[11px] text-nb-text-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                {t(`speech.${prefix}License`)}{' '}
                <a
                  href={
                    id === 'voxtral-local'
                      ? 'https://creativecommons.org/licenses/by-nc/4.0/'
                      : 'https://www.apache.org/licenses/LICENSE-2.0'
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {t('speech.viewLicense')}
                </a>
              </span>
            </label>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {!ready && !installing && status?.kind !== 'unsupported' && (
              <GlassButton
                size="sm"
                disabled={!accepted || working}
                onClick={() => void install()}
              >
                {working ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                {t('speech.installModel')}
              </GlassButton>
            )}
            {installing && (
              <GlassButton
                size="sm"
                onClick={() => void localTtsModels.cancelInstall(id)}
              >
                <X size={12} />
                {t('speech.cancelInstall')}
              </GlassButton>
            )}
            {ready && (
              <>
                <GlassButton
                  size="sm"
                  variant="accent"
                  onClick={() => void selectModel()}
                >
                  <Volume2 size={12} />
                  {t('speech.useLocalModel')}
                </GlassButton>
                <GlassButton
                  size="sm"
                  disabled={working}
                  onClick={() => void testVoice()}
                >
                  {working && <Loader2 size={12} className="animate-spin" />}
                  {t('speech.testVoice')}
                </GlassButton>
                {status.loaded && (
                  <GlassButton
                    size="sm"
                    disabled={working}
                    onClick={() => void run(() => localTtsModels.unload(id))}
                  >
                    {t('speech.unloadModel')}
                  </GlassButton>
                )}
                <GlassButton size="sm" disabled={working} onClick={() => void remove()}>
                  <Trash2 size={12} />
                  {t('speech.removeModel')}
                </GlassButton>
              </>
            )}
          </div>
          {status?.kind === 'unsupported' && status.message && (
            <FieldNote tone="muted">{status.message}</FieldNote>
          )}
          {notice && <FieldNote tone="muted">{notice}</FieldNote>}
          {error && <FieldNote tone="danger">{error}</FieldNote>}
        </div>
      </div>
    </div>
  );
}
