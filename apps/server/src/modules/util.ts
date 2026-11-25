export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
export const isoRequired = (value: Date) => value.toISOString();
