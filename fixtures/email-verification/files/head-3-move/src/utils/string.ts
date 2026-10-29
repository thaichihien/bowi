// String helpers.

export function capitalize(input: string) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

export function truncate(input: string, max: number) {
  return input.length <= max ? input : input.slice(0, max - 1) + '…';
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '');
}
