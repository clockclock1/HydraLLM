import { cn } from '../utils/cn';

type LoadingSpinnerSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<LoadingSpinnerSize, string> = {
  sm: 'loading-comp-react-sm',
  md: 'loading-comp-react-md',
  lg: 'loading-comp-react-lg',
};

export function LoadingSpinner({
  size = 'md',
  className,
}: {
  size?: LoadingSpinnerSize;
  className?: string;
}) {
  return (
    <span
      className={cn('loading-comp-react shrink-0', sizeClass[size], className)}
      aria-hidden="true"
    />
  );
}

export default function LoadingOverlay({
  show,
  label = 'Loading...',
}: {
  show: boolean;
  label?: string;
}) {
  return (
    <div
      className={cn(
        'loading-comp-global-react fixed inset-0 z-[80] flex items-center justify-center transition-all duration-300',
        show ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      )}
      aria-hidden={!show}
    >
      <div
        className={cn(
          'loading-comp-panel flex min-w-40 flex-col items-center gap-3 rounded-2xl border border-white/60 bg-white/95 px-6 py-5 text-blue-700 shadow-2xl shadow-slate-950/20',
          show ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'
        )}
      >
        <LoadingSpinner size="lg" />
        <span className="text-sm font-semibold text-slate-700">{label}</span>
      </div>
    </div>
  );
}
