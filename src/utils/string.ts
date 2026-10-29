export const escape = (name: string) => '"' + name.replace(/"/g, '""') + '"';
