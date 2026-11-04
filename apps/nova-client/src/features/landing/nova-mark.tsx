import './landing.css';

export function NovaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`landing-mark ${small ? 'landing-mark-small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M7 23V9h4l10 14h4V9M7 9l18 14"
          stroke="currentColor"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
