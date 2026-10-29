// Date helpers shared by reports and emails.

export const formatDate = (d: Date) =>
  d.toISOString().slice(0, 10);

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTime(d: Date) {
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

export function addDays(d: Date, days: number) {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export const isWeekend = (d: Date) => [0, 6].includes(d.getUTCDay());
