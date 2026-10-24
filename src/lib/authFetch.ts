// Wrapper attorno a fetch che allega automaticamente il token di sessione
// (JWT rilasciato dopo il login + verifica OTP) come header Authorization,
// per le rotte API che richiedono autenticazione lato server.
// Gli Admin di GEM possono guardare un'altra azienda: la scelta viaggia
// nell'header X-Azienda (il server la accetta solo da loro).
export const CHIAVE_AZIENDA_VISTA = 'gem_azienda_vista';

export function aziendaVista(): string | null {
  try { return sessionStorage.getItem(CHIAVE_AZIENDA_VISTA); } catch { return null; }
}

export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = sessionStorage.getItem('gem_token');
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const az = aziendaVista();
  if (az) headers.set('X-Azienda', az);
  return fetch(url, { ...options, headers });
}
