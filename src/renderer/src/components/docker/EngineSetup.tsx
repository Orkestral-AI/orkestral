import { RefreshCw } from 'lucide-react';

/** Tela quando não há engine Docker. Sem auto-instalar nada: só instrui e
 *  deixa o usuário tentar de novo depois de subir o engine (Docker/OrbStack/Colima). */
export function EngineSetup({ onReady }: { onReady: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-sm text-text-secondary">
      <div className="max-w-md">
        <p className="mb-2 text-base font-medium text-text-primary">
          Nenhum engine Docker encontrado
        </p>
        <p className="mb-5">
          Suba um engine Docker (ex.: Docker Desktop ou OrbStack) e tente de novo.
        </p>
        <button
          type="button"
          onClick={onReady}
          className="inline-flex items-center gap-2 rounded-md bg-surface-elevated px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover"
        >
          <RefreshCw className="h-4 w-4" />
          Tentar de novo
        </button>
      </div>
    </div>
  );
}
