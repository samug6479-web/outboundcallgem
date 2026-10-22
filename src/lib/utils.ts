import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Legge un CSV di contatti "nome, numero". Accetta virgola, punto e virgola
// (Excel in italiano) o tabulazione, righe Windows (CRLF), virgolette e
// riga di intestazione. Usato da Nuova Campagna e da Liste Salvate.
export function parseContactsCsv(text: string): { nome: string; numero: string }[] {
  const out: { nome: string; numero: string }[] = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const parts = line.split(sep).map(p => p.trim().replace(/^"|"$/g, '').trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    if (['nome', 'name'].includes(parts[0].toLowerCase())) continue;
    out.push({ nome: parts[0], numero: parts[1] });
  }
  return out;
}

export function normalizePhoneNumber(num: string): string {
  if (!num) return num;
  // Rimuovi spazi, trattini, punti, parentesi
  let n = String(num).trim().replace(/[\s\-\.()\/]/g, '');

  // Caso 1: già in formato internazionale con +39 → lascia stare
  if (n.startsWith('+39')) return n;

  // Caso 2: prefisso 0039 → sostituisci con +39
  if (n.startsWith('0039')) return '+' + n.slice(2);

  // Caso 3: prefisso 39 scritto senza + (es. 393331234567) → aggiungi solo il +
  // Riconosciuto quando dopo il 39 il numero prosegue con 0 o 3 (avvio tipico
  // di un numero italiano: mobile 3xx o fisso 0xx) ed è abbastanza lungo da
  // essere plausibilmente un +39 e non, ad esempio, un numero locale che
  // inizia semplicemente per "39".
  if (/^39[03]\d{7,10}$/.test(n)) return '+' + n;

  // Caso 4: qualsiasi altro prefisso internazionale (+ o 00 diverso da Italia) → lascia stare
  if (n.startsWith('+') || n.startsWith('00')) return n;

  // Caso 5: nessun prefisso — numero italiano "nudo" (mobile 3xx o fisso 0xx) → aggiungi +39
  if (/^[03]\d{6,10}$/.test(n)) return '+39' + n;

  return n;
}

export function isValidPhoneNumber(num: string) {
  if (!num) return false;
  const normalized = normalizePhoneNumber(String(num).trim());
  const NUM_RE = /^\+?[0-9]{6,15}$/;
  return NUM_RE.test(normalized);
}

export function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
