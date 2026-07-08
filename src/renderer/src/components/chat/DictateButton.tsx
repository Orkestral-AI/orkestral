import { useEffect } from 'react';
import type { JSX } from 'react';
import { Mic, Loader2, Square } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { useStreamingDictation } from '@renderer/lib/audio/useStreamingDictation';
import { useVoiceInstallPrompt } from '@renderer/lib/voice/useVoiceInstallPrompt';
import { toast } from '@renderer/stores/toastStore';

/**
 * Botão de ditado streaming. Reporta o texto ao vivo via onLiveText (parciais)
 * e o texto final via onFinalText. O composer decide como exibir.
 */
export function DictateButton({
  onLiveText,
  onFinalText,
  onStart,
  onCancel,
  className,
}: {
  onLiveText: (text: string) => void;
  onFinalText: (text: string) => void;
  onStart: () => void;
  onCancel: () => void;
  className?: string;
}): JSX.Element {
  const { t } = useT();
  const dictation = useStreamingDictation();
  const promptVoiceInstall = useVoiceInstallPrompt();
  const voiceStatusQuery = useQuery({
    queryKey: ['voice', 'status'],
    queryFn: () => window.orkestral['voice:get-status'](),
    staleTime: 30_000,
  });
  const voiceInstalled = voiceStatusQuery.data?.installed ?? false;

  useEffect(() => {
    if (dictation.state === 'recording') onLiveText(dictation.liveText);
  }, [dictation.liveText, dictation.state, onLiveText]);

  useEffect(() => {
    if (dictation.state === 'error' && dictation.error) {
      toast.error(t('chat.input.dictateError'), dictation.error);
      onCancel();
    }
  }, [dictation.state, dictation.error, t, onCancel]);

  async function handleClick(): Promise<void> {
    if (!voiceInstalled) {
      promptVoiceInstall();
      return;
    }
    if (dictation.state === 'recording') {
      const text = await dictation.stopAndFinalize();
      onFinalText(text ?? '');
    } else if (dictation.state === 'idle' || dictation.state === 'error') {
      onStart();
      await dictation.start();
    }
  }

  const recording = dictation.state === 'recording';
  const transcribing = dictation.state === 'transcribing';
  const label = !voiceInstalled
    ? t('chat.input.dictateInstall')
    : recording
      ? t('chat.input.dictateStop')
      : transcribing
        ? t('chat.input.dictateTranscribing')
        : t('chat.input.dictate');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={transcribing}
      aria-label={label}
      title={label}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md transition-colors',
        recording
          ? 'bg-accent-red/15 text-accent-red'
          : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
        transcribing && 'opacity-60',
        className,
      )}
    >
      {transcribing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : recording ? (
        <Square className="h-3 w-3 fill-current" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
