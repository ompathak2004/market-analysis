type ClarityCommand = ["set", string, string] | ["stop"];
type Clarity = ((...command: ClarityCommand) => void) & { q?: ClarityCommand[] };

declare global {
  interface Window {
    clarity?: Clarity;
  }
}

const PRODUCTION_HOSTS = new Set([
  "market-analysis.ompathak.dev",
  "market-analysis-shinchan21.vercel.app",
  "market-analysis-chi.vercel.app",
]);

function privatePath(pathname: string): boolean {
  return /^\/(admin|api|bot)(\/|$)/.test(pathname);
}

export function initializeClarity(projectId: string | undefined): void {
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" ||
    !projectId ||
    !/^[a-z0-9]+$/i.test(projectId) ||
    !PRODUCTION_HOSTS.has(window.location.hostname) ||
    privatePath(window.location.pathname) ||
    window.clarity
  ) {
    return;
  }

  const clarity: Clarity = (...command) => {
    clarity.q?.push(command);
  };
  clarity.q = [];
  window.clarity = clarity;
  clarity("set", "site_host", window.location.hostname);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${projectId}`;
  script.onload = () => {
    if (privatePath(window.location.pathname)) window.clarity?.("stop");
  };
  document.head.appendChild(script);
}

export function stopClarityOnPrivateNavigation(url: string): void {
  if (privatePath(new URL(url, window.location.origin).pathname)) {
    window.clarity?.("stop");
  }
}
