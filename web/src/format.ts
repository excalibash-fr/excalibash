// Display formatting shared by the windows and panels.

/** A byte count in binary units: `512 o`, `3.4 Kio`, `12.0 Mio`. */
export const fmtBytes = (n: number) => (n < 1024 ? `${n} o` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} Kio` : `${(n / 1024 ** 2).toFixed(1)} Mio`);
