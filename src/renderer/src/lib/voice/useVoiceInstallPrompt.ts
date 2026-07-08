import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '@renderer/i18n';
import { toast } from '@renderer/stores/toastStore';

/**
 * Retorna uma função que avisa "Modo de Voz não instalado" com um CTA
 * **Instalar** que leva direto pra Integrações. Compartilhado entre o botão de
 * ditado e o de conversa realtime (mesma mensagem, mesma ação) pra não duplicar.
 */
export function useVoiceInstallPrompt(): () => void {
  const navigate = useNavigate();
  const { t } = useT();
  return useCallback(() => {
    toast.info(t('chat.voice.installTitle'), t('chat.voice.installDescription'), {
      action: {
        label: t('chat.voice.installAction'),
        onClick: () => navigate('/integrations'),
      },
    });
  }, [navigate, t]);
}
