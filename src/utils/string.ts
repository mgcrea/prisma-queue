export const escape = (name: string) => '"' + name.replace(/"/g, '""') + '"';

export const capitalize = (string: string) => string.charAt(0).toUpperCase() + string.slice(1);
export const uncapitalize = (string: string) => string.charAt(0).toLowerCase() + string.slice(1);
