export const ACODE_SETUP_URL = 'acode://github/setup/complete';

export function initializeSetupReturn({
  clearSchedule = globalThis.clearTimeout,
  document = globalThis.document,
  navigate = (url) => globalThis.location.assign(url),
  schedule = globalThis.setTimeout,
} = {}) {
  const button = document?.querySelector('[data-open-acode]');
  if (!button) return () => {};

  const openAcode = () => {
    try {
      navigate(ACODE_SETUP_URL);
    } catch (_error) {
      // The manual link remains available when automatic navigation is denied.
    }
  };
  const handleClick = (event) => {
    event.preventDefault();
    openAcode();
  };

  button.href = ACODE_SETUP_URL;
  button.addEventListener('click', handleClick);
  const timer = schedule(openAcode, 250);

  return () => {
    clearSchedule(timer);
    button.removeEventListener('click', handleClick);
  };
}

if (typeof document !== 'undefined') initializeSetupReturn();
